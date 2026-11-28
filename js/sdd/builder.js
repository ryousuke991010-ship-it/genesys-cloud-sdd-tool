/* 設計書 → Genesys Cloud への構築
 *
 * 1. buildPlan(): 設計書の各要素が組織に既にあるかを調べ、計画を作る(読むだけ)
 *      create = 新しく作る / update = このアプリが作ったものに新しい版を出す / exists = 既存(触らない)
 *      error  = 確認できない・前提が足りない(実行しない) / manual = APIが無い・公開されていないため手作業
 * 2. executePlan(): 利用者が確認した計画のうち create / update だけを順に実行する
 * 3. verifyPlan(): 作成・更新・既存の各要素を取り直し、設計書どおりかを確かめる(成功応答だけで成功としない)
 *
 * 利用者や他のツールが作った既存設定は、上書き・削除しない。
 * 「update」になるのは、このアプリが作った印(説明文の MANAGED_MARK、または過去の構築記録のID)があるものだけで、
 * それも版を積み増す形(フロー・AVAは過去の版が残る / コールルーティングは番号とフローの割り当て)に限る。
 */
import { gcGet, gcWrite, gcQuery, gcList, findByName, uploadToPresignedUrl, sleepMs } from '../core/gcApi.js';
import { DAYS } from './spec.js';
import { MANAGED_MARK, callFlowYaml, callFlowKinds, callFlowName, callRoutingName, botFlowYaml } from './flowYaml.js';
import { avaDefinition, findAva, validateDefinition, createAndPublishVersion, getAva, getAvaVersion, latestSavedVersion, AVA_BASE } from './ava.js';

const P = {
  skill: '/api/v2/routing/skills',
  wrapup: '/api/v2/routing/wrapupcodes',
  queue: '/api/v2/routing/queues',
  schedule: '/api/v2/architect/schedules',
  scheduleGroup: '/api/v2/architect/schedulegroups',
  dataTable: '/api/v2/flows/datatables',
  flow: '/api/v2/flows',
  botFlow: '/api/v2/flows',
  ivr: '/api/v2/architect/ivrs'
};

export const TYPE_LABEL = {
  skill: 'ACDスキル', wrapup: '後処理コード', queue: 'キュー',
  schedule: 'スケジュール', scheduleGroup: 'スケジュールグループ',
  dataTable: 'データテーブル', flow: '着信フロー', botFlow: 'ボットフロー',
  ivr: 'コールルーティング(電話番号)', agentSkill: 'スキル付与', queueMember: 'キューへの所属',
  ava: 'AVA(AIエージェント)', manual: '手作業'
};

/** 組織内で名前が衝突しないよう、スケジュール類には業務名を前に付ける */
export function scheduleName(spec, name) { return `${spec.business.name}_${name}`; }
export function scheduleGroupName(spec) { return `${spec.business.name}_営業時間`; }

/* 2024-01-01は月曜日。その週の中で、指定曜日のうち最初の日を開始日にする */
function firstDateFor(days) {
  const idx = Math.min(...days.map(d => DAYS.indexOf(d)));
  return `2024-01-0${1 + idx}`;
}

function nextDate(date) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function schedulePayload(kind, item, name) {
  if (kind === 'hours') {
    const day = firstDateFor(item.days);
    return {
      name,
      start: `${day}T${item.open}:00.000`,
      end: `${day}T${item.close}:00.000`,
      rrule: `FREQ=WEEKLY;BYDAY=${item.days.join(',')}`
    };
  }
  return { name, start: `${item.date}T00:00:00.000`, end: `${nextDate(item.date)}T00:00:00.000` };
}

/** データテーブルのJSONスキーマ(キー列は "key"、他の列は列名をそのままプロパティ名にする) */
export function dataTablePayload(t) {
  const properties = {
    key: { title: t.key, type: 'string', $id: '/properties/key', displayOrder: 0, minLength: 1, maxLength: 256 }
  };
  t.columns.forEach((c, i) => {
    properties[c.name] = { title: c.name, type: c.type, $id: `/properties/${c.name}`, displayOrder: i + 1, ...(c.type === 'boolean' ? { default: false } : {}) };
  });
  return {
    name: t.name,
    description: `${MANAGED_MARK} ${t.description || ''}`.trim(),
    schema: { $schema: 'http://json-schema.org/draft-04/schema#', type: 'object', properties, required: ['key'], additionalProperties: false }
  };
}

function rowPayload(t, row) {
  const out = { key: String(row.key) };
  t.columns.forEach(c => {
    if (!(c.name in row)) return;
    const v = row[c.name];
    out[c.name] = c.type === 'boolean' ? (v === true || v === 'true' || v === 1 || v === '1')
      : (c.type === 'integer' || c.type === 'number') ? Number(v) : String(v ?? '');
  });
  return out;
}

const isManaged = (entity, knownIds) => Boolean(entity && ((entity.description || '').includes(MANAGED_MARK) || knownIds.has(entity.id)));

/** メールアドレスでユーザーを1人探す(検索APIは読み取り) */
async function findUserByEmail(email) {
  const data = await gcQuery('/api/v2/users/search', { pageSize: 5, query: [{ type: 'EXACT', fields: ['email'], value: email }] });
  const list = Array.isArray(data?.results) ? data.results : [];
  return list.find(u => (u.email || '').toLowerCase() === email) || null;
}

async function listAll(path) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const data = await gcGet(`${path}${path.includes('?') ? '&' : '?'}pageSize=100&pageNumber=${page}`);
    if (!data || !Array.isArray(data.entities)) throw new Error(`${path.split('?')[0]} の応答形式が想定と違います。`);
    out.push(...data.entities);
    if (data.entities.length < 100 || page >= (data.pageCount || 1)) break;
  }
  return out;
}

async function userQueueIds(userId) {
  const [a, b] = await Promise.all([
    listAll(`/api/v2/users/${encodeURIComponent(userId)}/queues?joined=true`),
    listAll(`/api/v2/users/${encodeURIComponent(userId)}/queues?joined=false`)
  ]);
  return new Set([...a, ...b].map(q => q.id));
}

async function userSkillIds(userId) {
  return new Set((await listAll(`/api/v2/users/${encodeURIComponent(userId)}/routingskills`)).map(s => s.id));
}

/** 組織に手で行う必要がある作業(公開APIが無い/組織全体の設定/確認できていないもの) */
export function manualTasks(spec) {
  const out = [];
  if (spec.callRouting.numbers.length) out.push({ name: '電話番号の購入・DIDプールへの登録・回線(トランク)の設定', detail: '組織の契約と電話回線にかかわるため、Genesys Cloudの管理画面で行います。登録済みの番号ならこのアプリがフローに割り当てます。' });
  if (spec.botFlows.length || spec.ava.length) out.push({ name: '着信フロー/メッセージフローからボット・AVAを呼び出す設定', detail: 'ボットフロー・AVAはこのアプリで作成・公開します。電話やチャットの入口から呼び出すアクションは、Architectで「ボットフローを呼び出す」を追加してください(フロー定義の書き方を公式資料で確認でき次第、自動化します)。' });
  if (spec.ivr.menu.some(m => m.digit === '*' || m.digit === '#')) out.push({ name: 'IVRメニューの * / # の選択肢', detail: 'Architectで着信フローに追加してください。' });
  return out;
}

/** 組織を読んで計画を作る(書き込みはしない)。knownIds: 過去にこのプロジェクトで作ったもののID */
export async function buildPlan(spec, onProgress = () => {}, knownIds = new Set()) {
  const items = [];
  const push = it => items.push({ status: 'pending', ...it });
  spec.skills.forEach(n => push({ type: 'skill', name: n, payload: { name: n } }));
  spec.wrapupCodes.forEach(n => push({ type: 'wrapup', name: n, payload: { name: n } }));
  spec.queues.forEach(q => push({ type: 'queue', name: q.name, payload: { name: q.name, description: q.description || undefined } }));
  spec.hours.forEach(h => {
    const name = scheduleName(spec, h.name);
    push({ type: 'schedule', name, role: 'open', payload: schedulePayload('hours', h, name) });
  });
  spec.holidays.forEach(h => {
    const name = scheduleName(spec, h.name);
    push({ type: 'schedule', name, role: 'holiday', payload: schedulePayload('holiday', h, name) });
  });
  if (spec.hours.length || spec.holidays.length) push({ type: 'scheduleGroup', name: scheduleGroupName(spec), payload: null });
  spec.dataTables.forEach(t => push({ type: 'dataTable', name: t.name, payload: dataTablePayload(t), rows: t.rows.map(r => rowPayload(t, r)) }));
  callFlowKinds(spec).forEach(kind => push({ type: 'flow', kind, name: callFlowName(spec, kind), yaml: callFlowYaml(spec, kind) }));
  spec.botFlows.forEach(b => push({ type: 'botFlow', name: b.name, yaml: botFlowYaml(b) }));
  if (spec.callRouting.numbers.length) push({ type: 'ivr', name: callRoutingName(spec), numbers: spec.callRouting.numbers });
  spec.agents.forEach(a => {
    a.skills.forEach(k => push({ type: 'agentSkill', name: `${a.email} ← ${k.name}(${k.proficiency})`, email: a.email, skill: k.name, proficiency: k.proficiency }));
    a.queues.forEach(q => push({ type: 'queueMember', name: `${a.email} → ${q}`, email: a.email, queue: q }));
  });
  spec.ava.forEach(a => push({ type: 'ava', name: a.name, definition: avaDefinition(a), language: a.language }));

  const planned = type => new Set(items.filter(i => i.type === type).map(i => i.name));
  const users = new Map();
  const userOf = async email => {
    if (!users.has(email)) users.set(email, findUserByEmail(email));
    return users.get(email);
  };

  let done = 0;
  for (const it of items) {
    onProgress(`組織の状態を確認中… (${++done}/${items.length}) ${it.name}`);
    try {
      await planItem(it, { knownIds, planned, userOf });
    } catch (e) {
      it.status = 'error';
      it.error = e.message;
    }
  }
  manualTasks(spec).forEach(m => items.push({ type: 'manual', name: m.name, status: 'manual', error: m.detail }));
  return items;
}

async function planItem(it, { knownIds, planned, userOf }) {
  switch (it.type) {
    case 'flow':
    case 'botFlow': {
      const found = await findByName(P.flow, it.name, `&type=${it.type === 'flow' ? 'INBOUNDCALL' : 'BOT'}`);
      it.id = found?.id || null;
      it.status = !found ? 'create' : isManaged(found, knownIds) ? 'update' : 'exists';
      if (it.status === 'exists') it.error = 'このアプリ以外で作られた同名のフローのため、変更しません。';
      return;
    }
    case 'ivr': {
      const found = await findByName(P.ivr, it.name);
      it.id = found?.id || null;
      it.status = !found ? 'create' : isManaged(found, knownIds) ? 'update' : 'exists';
      const problems = [];
      for (const n of it.numbers) {
        const dids = await gcList(`/api/v2/telephony/providers/edges/dids?pageSize=25&phoneNumber=${encodeURIComponent(n)}`);
        if (!dids.some(d => d.phoneNumber === n)) problems.push(`${n} は組織のDIDに登録されていません(番号の登録は手作業)`);
        const used = await gcList(`${P.ivr}?pageSize=25&dnis=${encodeURIComponent(n)}`);
        const other = used.find(x => x.id !== it.id && (x.dnis || []).includes(n));
        if (other) problems.push(`${n} は別のコールルーティング「${other.name}」で使用中です(取り上げません)`);
      }
      if (it.status === 'exists') problems.push('このアプリ以外で作られた同名のコールルーティングのため、変更しません。');
      if (problems.length) { it.status = it.status === 'exists' ? 'exists' : 'error'; it.error = problems.join(' / '); }
      return;
    }
    case 'agentSkill':
    case 'queueMember': {
      const user = await userOf(it.email);
      if (!user) { it.status = 'error'; it.error = 'このメールアドレスのユーザーが組織にいません(ユーザーの登録はGenesys Cloudの管理画面で行ってください)。'; return; }
      it.userId = user.id;
      it.userName = user.name;
      const kind = it.type === 'agentSkill' ? 'skill' : 'queue';
      const target = it.type === 'agentSkill' ? it.skill : it.queue;
      const found = await findByName(P[kind], target);
      if (!found && !planned(kind).has(target)) { it.status = 'error'; it.error = `${TYPE_LABEL[kind]}「${target}」が組織にも設計にもありません。`; return; }
      if (found) {
        const has = it.type === 'agentSkill' ? (await userSkillIds(user.id)).has(found.id) : (await userQueueIds(user.id)).has(found.id);
        if (has) { it.status = 'exists'; it.error = '付与済み'; return; }
      }
      it.status = 'create';
      return;
    }
    case 'ava': {
      const found = await findAva(it.name);
      it.id = found?.id || null;
      it.status = !found ? 'create' : knownIds.has(found.id) ? 'update' : 'exists';
      if (it.status === 'exists') it.error = 'このアプリ以外で作られた同名のAVAのため、版を追加しません。';
      if (found && it.status === 'update') {
        const check = await validateDefinition(found.id, it.definition);
        if (!check.ok) { it.status = 'error'; it.error = `定義の事前検証で不合格: ${[check.message, ...check.details].join(' / ')}`; }
      }
      return;
    }
    default: {
      const found = await findByName(P[it.type], it.name);
      it.status = found ? 'exists' : 'create';
      it.id = found?.id || null;
    }
  }
}

/* ---------- 実行 ---------- */

/** Architectジョブでフロー定義(YAML)を取り込み、公開まで待つ。戻り値はフローID */
async function importFlowYaml(it, onProgress) {
  const job = await gcWrite('POST', '/api/v2/flows/jobs', {});
  if (!job?.id || !job?.presignedUrl) throw new Error('Architectジョブを登録できませんでした(アップロード先が返りませんでした)。');
  await uploadToPresignedUrl(job.presignedUrl, job.headers, it.yaml);
  const deadline = Date.now() + 180 * 1000;
  let state;
  while (Date.now() < deadline) {
    await sleepMs(3000);
    onProgress(`${TYPE_LABEL[it.type]}「${it.name}」をArchitectに取り込み中…`);
    state = await gcGet(`/api/v2/flows/jobs/${encodeURIComponent(job.id)}`);
    if (state?.status === 'Success' || state?.status === 'Failure') break;
  }
  if (state?.status !== 'Success') {
    const msgs = (state?.messages || []).map(m => (typeof m === 'string' ? m : m.text || m.message || JSON.stringify(m))).slice(0, 5);
    throw new Error(state?.status === 'Failure' ? `Architectが取り込みを拒否しました: ${msgs.join(' / ') || '理由不明'}` : '取り込みが3分以内に終わりませんでした。Architectで状態を確認してください。');
  }
  const flowId = state.flow?.id || it.id;
  if (!flowId) throw new Error('取り込みは成功しましたが、フローのIDが返りませんでした。Architectで確認してください。');
  const flow = await gcGet(`${P.flow}/${encodeURIComponent(flowId)}`);
  if (!flow?.publishedVersion) {
    onProgress(`${TYPE_LABEL[it.type]}「${it.name}」を公開中…`);
    await gcWrite('POST', `/api/v2/flows/actions/publish?flow=${encodeURIComponent(flowId)}`);
    for (let i = 0; i < 40; i++) {
      await sleepMs(3000);
      const f = await gcGet(`${P.flow}/${encodeURIComponent(flowId)}`);
      const op = f?.currentOperation;
      if (op?.actionName === 'PUBLISH' && op.actionStatus === 'FAILURE') throw new Error(`公開に失敗しました: ${op.errorMessage || '理由不明'}`);
      if (f?.publishedVersion) break;
    }
  }
  return flowId;
}

const ref = id => (id ? { id } : undefined);

async function executeItem(spec, it, items, onProgress) {
  const idOf = (type, pred = () => true) => items.find(x => x.type === type && pred(x) && x.id)?.id;
  switch (it.type) {
    case 'scheduleGroup': {
      const ids = role => items.filter(x => x.type === 'schedule' && x.role === role && x.id).map(x => ({ id: x.id }));
      const missing = items.filter(x => x.type === 'schedule' && !x.id);
      if (missing.length) throw new Error(`スケジュール(${missing.map(x => x.name).join('、')})が作成できていないため、グループを作りませんでした。`);
      it.payload = { name: it.name, timeZone: spec.timeZone, openSchedules: ids('open'), holidaySchedules: ids('holiday'), closedSchedules: [] };
      const created = await gcWrite('POST', P.scheduleGroup, it.payload);
      it.id = created?.id;
      return;
    }
    case 'dataTable': {
      const created = await gcWrite('POST', P.dataTable, it.payload);
      it.id = created?.id;
      if (!it.id) return;
      let n = 0;
      for (const row of it.rows) {
        onProgress(`データテーブル「${it.name}」に行を追加中… (${++n}/${it.rows.length})`);
        await gcWrite('POST', `${P.dataTable}/${encodeURIComponent(it.id)}/rows`, row);
      }
      return;
    }
    case 'flow':
    case 'botFlow':
      it.id = await importFlowYaml(it, onProgress);
      return;
    case 'ivr': {
      const flowId = kind => idOf('flow', x => x.kind === kind);
      const sg = idOf('scheduleGroup');
      if (!flowId('open')) throw new Error('営業時間内の着信フローが無いため、電話番号を割り当てませんでした。');
      const payload = {
        name: it.name,
        description: `${MANAGED_MARK} ${spec.business.name}`,
        dnis: it.numbers,
        openHoursFlow: ref(flowId('open')),
        closedHoursFlow: ref(flowId('closed') || (sg ? flowId('open') : undefined)),
        holidayHoursFlow: ref(flowId('holiday') || (sg ? flowId('closed') || flowId('open') : undefined)),
        scheduleGroup: ref(sg)
      };
      if (it.status === 'update') {
        const cur = await gcGet(`${P.ivr}/${encodeURIComponent(it.id)}`);
        it.payload = { ...cur, ...payload, version: cur.version };
        await gcWrite('PUT', `${P.ivr}/${encodeURIComponent(it.id)}`, it.payload);
      } else {
        it.payload = payload;
        const created = await gcWrite('POST', P.ivr, payload);
        it.id = created?.id;
      }
      return;
    }
    case 'agentSkill': {
      const skillId = idOf('skill', x => x.name === it.skill) || (await findByName(P.skill, it.skill))?.id;
      if (!skillId) throw new Error(`スキル「${it.skill}」が見つかりません。`);
      it.targetId = skillId;
      await gcWrite('POST', `/api/v2/users/${encodeURIComponent(it.userId)}/routingskills`, { id: skillId, proficiency: it.proficiency });
      it.id = it.userId;
      return;
    }
    case 'queueMember': {
      const queueId = idOf('queue', x => x.name === it.queue) || (await findByName(P.queue, it.queue))?.id;
      if (!queueId) throw new Error(`キュー「${it.queue}」が見つかりません。`);
      it.targetId = queueId;
      await gcWrite('POST', `${P.queue}/${encodeURIComponent(queueId)}/members`, [{ id: it.userId }]);
      it.id = it.userId;
      return;
    }
    case 'ava': {
      if (it.status === 'create') {
        const created = await gcWrite('POST', AVA_BASE, { name: it.name });
        if (!created?.id) throw new Error('AVAの作成応答にIDが含まれていません。');
        it.id = created.id;
      }
      const check = await validateDefinition(it.id, it.definition);
      if (!check.ok) throw new Error(`定義の検証で不合格: ${[check.message, ...check.details].join(' / ')}`);
      const r = await createAndPublishVersion(it.id, it.definition, 'TestReady', onProgress);
      it.version = r.version;
      it.publishStatus = r.jobStatus;
      if (r.jobStatus !== 'Succeeded') throw new Error(`版 v${r.version} を作成しましたが、テスト公開に失敗しました: ${r.errors.map(e => e.message).join(' / ') || r.jobStatus}`);
      return;
    }
    default: {
      const created = await gcWrite('POST', P[it.type], it.payload);
      it.id = created?.id;
    }
  }
}

/**
 * 「作成」「更新」の項目だけを実行する。items は確認時点で確定したもの(実行中に設計書が変わっても影響しない)。
 * 戻り値は各項目に result/error/id を書き込んだ配列。
 */
export async function executePlan(spec, items, onProgress = () => {}) {
  const targets = items.filter(i => i.status === 'create' || i.status === 'update');
  let n = 0;
  for (const it of items) {
    if (it.status !== 'create' && it.status !== 'update') {
      it.result = it.status === 'exists' ? 'skipped' : it.status === 'manual' ? 'manual' : 'error';
      continue;
    }
    onProgress(`構築中… (${++n}/${targets.length}) ${TYPE_LABEL[it.type]}「${it.name}」`);
    try {
      await executeItem(spec, it, items, onProgress);
      if (!it.id) throw new Error('作成の応答にIDが含まれていません。組織で作成されたか確認してください。');
      it.result = it.status === 'update' ? 'updated' : 'created';
    } catch (e) {
      it.result = 'error';
      it.error = e.message;
    }
  }
  return items;
}

/* ---------- 検証 ---------- */

function compareSchedule(actual, expected) {
  const diffs = [];
  const norm = v => String(v || '').replace(/\.\d+$/, '').replace(/Z$/, '');
  if (norm(actual.start) !== norm(expected.start)) diffs.push(`開始 ${actual.start} ≠ 設計 ${expected.start}`);
  if (norm(actual.end) !== norm(expected.end)) diffs.push(`終了 ${actual.end} ≠ 設計 ${expected.end}`);
  if ((actual.rrule || '') !== (expected.rrule || '')) diffs.push(`繰り返し ${actual.rrule || 'なし'} ≠ 設計 ${expected.rrule || 'なし'}`);
  return diffs;
}

const sameIds = (list, ids) => {
  const a = new Set((list || []).map(x => x.id));
  return a.size === ids.size && [...a].every(x => ids.has(x));
};

async function verifyItem(spec, it, items) {
  const diffs = [];
  const get = path => gcGet(path);
  switch (it.type) {
    case 'agentSkill': {
      if (!(await userSkillIds(it.userId)).has(it.targetId || (await findByName(P.skill, it.skill))?.id)) diffs.push('スキルが付与されていません');
      return diffs;
    }
    case 'queueMember': {
      if (!(await userQueueIds(it.userId)).has(it.targetId || (await findByName(P.queue, it.queue))?.id)) diffs.push('キューに所属していません');
      return diffs;
    }
    case 'ava': {
      const ava = await getAva(it.id);
      if (ava?.name !== it.name) diffs.push(`名前「${ava?.name}」`);
      const v = it.version || latestSavedVersion(ava);
      if (!v) { diffs.push('版がありません'); return diffs; }
      const ver = await getAvaVersion(it.id, v);
      const d = ver?.definition || {};
      if (d.role !== it.definition.role) diffs.push('役割(role)が設計と違います');
      if (JSON.stringify(d.instructions || []) !== JSON.stringify(it.definition.instructions)) diffs.push('ガイドラインが設計と違います');
      if (ver?.status && !['TestReady', 'ProductionReady'].includes(ver.status)) diffs.push(`版 v${v} の状態が ${ver.status} です(未公開)`);
      return diffs;
    }
    case 'flow':
    case 'botFlow': {
      const f = await get(`${P.flow}/${encodeURIComponent(it.id)}`);
      if (f?.name !== it.name) diffs.push(`名前「${f?.name}」`);
      if (!f?.publishedVersion) diffs.push('公開されていません');
      if (f?.type && f.type !== (it.type === 'flow' ? 'INBOUNDCALL' : 'BOT')) diffs.push(`種類が ${f.type} です`);
      return diffs;
    }
    case 'ivr': {
      const x = await get(`${P.ivr}/${encodeURIComponent(it.id)}`);
      const want = new Set(it.numbers);
      const have = new Set(x?.dnis || []);
      if (want.size !== have.size || [...want].some(n => !have.has(n))) diffs.push(`電話番号 ${[...have].join(', ') || 'なし'} ≠ 設計 ${it.numbers.join(', ')}`);
      const flowId = kind => items.find(i => i.type === 'flow' && i.kind === kind)?.id;
      if (x?.openHoursFlow?.id !== flowId('open')) diffs.push('通常時フローが設計の着信フローではありません');
      const sg = items.find(i => i.type === 'scheduleGroup')?.id;
      if (sg && x?.scheduleGroup?.id !== sg) diffs.push('スケジュールグループが設計と違います');
      return diffs;
    }
    case 'dataTable': {
      const t = await get(`${P.dataTable}/${encodeURIComponent(it.id)}?expand=schema`);
      const props = t?.schema?.properties || {};
      Object.keys(it.payload.schema.properties).forEach(k => { if (!props[k]) diffs.push(`列「${k}」がありません`); });
      if (it.rows?.length && it.result === 'created') {
        const rows = await get(`${P.dataTable}/${encodeURIComponent(it.id)}/rows?pageSize=100&showbrief=true`);
        const keys = new Set((rows?.entities || []).map(r => r.key));
        const missing = it.rows.filter(r => !keys.has(r.key)).length;
        if (missing) diffs.push(`${missing}行が登録されていません`);
      }
      return diffs;
    }
    default: {
      const actual = await get(`${P[it.type]}/${encodeURIComponent(it.id)}`);
      if (actual?.name !== it.name) diffs.push(`名前「${actual?.name}」`);
      if (it.type === 'schedule') diffs.push(...compareSchedule(actual, it.payload));
      if (it.type === 'scheduleGroup') {
        const ids = role => new Set(items.filter(x => x.type === 'schedule' && x.role === role && x.id).map(x => x.id));
        if (!sameIds(actual.openSchedules, ids('open'))) diffs.push('営業時間スケジュールの組み合わせが設計と違います');
        if (!sameIds(actual.holidaySchedules, ids('holiday'))) diffs.push('休業日スケジュールの組み合わせが設計と違います');
        if (actual.timeZone && actual.timeZone !== spec.timeZone) diffs.push(`タイムゾーン ${actual.timeZone} ≠ 設計 ${spec.timeZone}`);
      }
      return diffs;
    }
  }
}

/** 作成済み・既存の各要素を組織から取り直して、設計書どおりかを確認する */
export async function verifyPlan(spec, items, onProgress = () => {}) {
  const results = [];
  let n = 0;
  for (const it of items) {
    if (it.type === 'manual') {
      results.push({ type: it.type, name: it.name, ok: null, detail: '手作業の項目です。Genesys Cloudの画面で確認してください。' });
      continue;
    }
    if (!it.id) {
      const why = it.status === 'error' && it.error ? `実行しませんでした: ${it.error}` : it.result === 'error' && it.error ? `作成に失敗: ${it.error}` : '組織に存在しません(未作成または作成失敗)';
      results.push({ type: it.type, name: it.name, ok: false, detail: why });
      continue;
    }
    onProgress(`検証中… (${++n}) ${it.name}`);
    try {
      const diffs = await verifyItem(spec, it, items);
      results.push({ type: it.type, name: it.name, ok: diffs.length === 0, detail: diffs.length ? diffs.join(' / ') : '設計どおり' });
    } catch (e) {
      results.push({ type: it.type, name: it.name, ok: false, detail: `取得できませんでした: ${e.message}` });
    }
  }
  return results;
}
