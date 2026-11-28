/* AVA(Agentic Virtual Agent)— 設計書 → 版の定義、および会話テスト
 *
 * 形とAPIの呼び方は、Genesys公式の genesys-ava-skills / ava-mcp(MIT)が実際に送っているものに合わせている:
 *   POST /api/v2/agentic/virtualagents                         {name}
 *   POST /api/v2/agentic/virtualagents/{id}/versions[?validateOnly=true]  {definition}
 *   POST /api/v2/agentic/virtualagents/{id}/versions/{v}/jobs  {virtualAgentVersion:{status}} → GET …/jobs/{jobId}
 *   POST /api/v2/agentic/virtualagents/{id}/sessions           {version, channel, inputData, language}
 *   POST /api/v2/agentic/virtualagents/{id}/sessions/{sid}/turns {inputEvent, previousTurn, version}
 * 定義の形は Platform API の AgenticVirtualAgentVersionDefinition(公開swagger)で確認済み。
 */
import { gcGet, gcWrite, gcQuery, sleepMs } from '../core/gcApi.js';

export const AVA_BASE = '/api/v2/agentic/virtualagents';
export const AVA_MARK = 'Genesys SDD Studio';

/** 設計書のAVA → 版の定義(definition) */
export function avaDefinition(a) {
  const events = [];
  if (a.userExitMessage) events.push({ type: 'UserExit', message: a.userExitMessage });
  if (a.escalationMessage) events.push({ type: 'Escalation', message: a.escalationMessage });
  if (a.guardrailMessage || a.guardrails.length) {
    events.push({
      type: 'Guardrails',
      message: a.guardrailMessage || 'そのご質問にはお答えできません。',
      violationThreshold: a.guardrailThreshold,
      ...(a.guardrailCrossedMessage ? { violationThresholdCrossedMessage: a.guardrailCrossedMessage } : {})
    });
  }
  return {
    role: a.role,
    instructions: a.instructions,
    ...(a.guardrails.length ? { guardrails: { custom: a.guardrails.map(instruction => ({ instruction, enabled: true })) } } : {}),
    tools: [],
    types: [],
    events,
    model: 'Stable'
  };
}

const versionOf = v => (v && typeof v === 'object' ? v.version : v) || null;

/** 名前の完全一致でAVAを探す(nameは大文字小文字を区別しない一致のため、返った中から選ぶ) */
export async function findAva(name) {
  const data = await gcGet(`${AVA_BASE}?pageSize=100&name=${encodeURIComponent(name)}`);
  if (!data || !Array.isArray(data.entities)) throw new Error('AVA一覧の応答形式が想定と違います(権限 agentic-virtualagents を確認してください)。');
  return data.entities.find(e => e?.name === name) || null;
}

/** サーバー側の検証だけを行う(版は作らない) */
export async function validateDefinition(avaId, definition) {
  try {
    await gcQuery(`${AVA_BASE}/${encodeURIComponent(avaId)}/versions?validateOnly=true`, { definition });
    return { ok: true };
  } catch (e) {
    const details = (e.body?.details || []).map(d => [d.fieldName, d.errorMessage || d.message].filter(Boolean).join(': ')).filter(Boolean);
    return { ok: false, message: e.message, details };
  }
}

/** 版を作ってテスト用(TestReady)に公開する。戻り値 { version, jobStatus } */
export async function createAndPublishVersion(avaId, definition, status = 'TestReady', onProgress = () => {}) {
  const created = await gcWrite('POST', `${AVA_BASE}/${encodeURIComponent(avaId)}/versions`, { definition });
  const version = String(created?.version ?? '');
  if (!version) throw new Error('版の作成応答に版番号が含まれていません。');
  const job = await publishVersion(avaId, version, status, onProgress);
  return { version, jobStatus: job.status, errors: job.errors || [] };
}

export async function publishVersion(avaId, version, status, onProgress = () => {}) {
  const base = `${AVA_BASE}/${encodeURIComponent(avaId)}/versions/${encodeURIComponent(version)}/jobs`;
  const job = await gcWrite('POST', base, { virtualAgentVersion: { status } });
  if (!job?.id) throw new Error('公開ジョブのIDが返りませんでした。');
  const deadline = Date.now() + 180 * 1000;
  while (Date.now() < deadline) {
    await sleepMs(3000);
    onProgress(`AVA v${version} を公開中(${status})…`);
    const j = await gcGet(`${base}/${encodeURIComponent(job.id)}`);
    if (j?.status === 'Succeeded' || j?.status === 'Failed') return j;
  }
  return { status: 'Timeout', errors: [{ message: '公開ジョブが3分以内に終わりませんでした。Genesys Cloudの画面で状態を確認してください。' }] };
}

export async function getAva(avaId) { return gcGet(`${AVA_BASE}/${encodeURIComponent(avaId)}`); }
export async function getAvaVersion(avaId, version) { return gcGet(`${AVA_BASE}/${encodeURIComponent(avaId)}/versions/${encodeURIComponent(version)}`); }
export const latestSavedVersion = ava => versionOf(ava?.latestSavedVersion);

/* ---------- 会話テスト(公開済みの版と、実際にテキストでやり取りする) ---------- */
const textOf = turn => (turn?.prompts?.text?.segments || []).map(s => s.text || '').join('');

export class AvaSession {
  constructor(avaId, version, language = 'ja-jp') {
    Object.assign(this, { avaId, version: String(version), language, id: null, lastTurnId: null, ended: false });
  }

  get base() { return `${AVA_BASE}/${encodeURIComponent(this.avaId)}/sessions`; }

  /** セッションを始めて最初の挨拶を返す */
  async start() {
    const s = await gcWrite('POST', this.base, {
      version: this.version,
      channel: { name: 'Messaging', inputModes: ['Text'], outputModes: ['Text'], userAgent: { name: 'GenesysWebWidget' } },
      inputData: {},
      language: this.language
    });
    if (!s?.id) throw new Error('会話セッションを開始できませんでした。');
    this.id = s.id;
    return this.turn(null);
  }

  /** text=null は挨拶の取得(NoOp)。AVAが処理を続ける間(nextAction=NoOp)はNoOpを送り続ける */
  async turn(text) {
    if (this.ended) throw new Error('この会話は終了しています。');
    const send = t => gcWrite('POST', `${this.base}/${encodeURIComponent(this.id)}/turns`, {
      inputEvent: t == null ? { type: 'NoOp', mode: 'Text' } : { type: 'UserInput', mode: 'Text', alternatives: [{ transcript: { text: t, confidence: 1 } }] },
      ...(this.lastTurnId ? { previousTurn: { id: this.lastTurnId } } : {}),
      version: this.version
    });
    let turn = await send(text);
    let reply = textOf(turn);
    const tools = [...(turn?.events?.toolCalls || [])].map(c => c.name);
    for (let i = 0; turn?.nextAction?.type === 'NoOp' && i < 50; i++) {
      this.lastTurnId = turn.id;
      turn = await send(null);
      reply += textOf(turn);
      tools.push(...(turn?.events?.toolCalls || []).map(c => c.name));
    }
    this.lastTurnId = turn?.id || this.lastTurnId;
    const next = turn?.nextAction?.type || 'WaitForInput';
    if (next === 'Exit' || next === 'Disconnect') this.ended = true;
    return { text: reply, next, reason: turn?.nextAction?.reason || null, tools, guardrails: turn?.events?.guardrails || null };
  }
}
