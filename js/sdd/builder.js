/* 設計書 → Genesys Cloud への構築
 *
 * 1. buildPlan(): 設計書の各要素が組織に既にあるかを名前で調べ、「作成/既存/手動」の計画を作る(読むだけ)
 * 2. executePlan(): 利用者が確認した計画のうち「作成」だけを順に実行する(既存のものは上書きしない)
 * 3. verifyPlan(): 作成・既存の各要素を取り直し、設計書どおりかを確かめる(成功応答だけで成功としない)
 *
 * 既存要素の更新・削除はしない。名前が同じものが既にある場合は「既存」として触らず、
 * 差分があれば検証で指摘する(本番組織の設定を黙って書き換えないため)。
 */
import { gcGet, gcWrite, findByName } from '../core/gcApi.js';
import { DAYS } from './spec.js';

const P = {
  skill: '/api/v2/routing/skills',
  wrapup: '/api/v2/routing/wrapupcodes',
  queue: '/api/v2/routing/queues',
  schedule: '/api/v2/architect/schedules',
  scheduleGroup: '/api/v2/architect/schedulegroups'
};

export const TYPE_LABEL = {
  skill: 'ACDスキル', wrapup: '後処理コード', queue: 'キュー',
  schedule: 'スケジュール', scheduleGroup: 'スケジュールグループ', flow: '着信フロー(IVR)'
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

/** 組織を読んで計画を作る(書き込みはしない) */
export async function buildPlan(spec, onProgress = () => {}) {
  const items = [];
  spec.skills.forEach(n => items.push({ type: 'skill', name: n, payload: { name: n } }));
  spec.wrapupCodes.forEach(n => items.push({ type: 'wrapup', name: n, payload: { name: n } }));
  spec.queues.forEach(q => items.push({ type: 'queue', name: q.name, payload: { name: q.name, description: q.description || undefined } }));
  spec.hours.forEach(h => {
    const name = scheduleName(spec, h.name);
    items.push({ type: 'schedule', name, role: 'open', payload: schedulePayload('hours', h, name) });
  });
  spec.holidays.forEach(h => {
    const name = scheduleName(spec, h.name);
    items.push({ type: 'schedule', name, role: 'holiday', payload: schedulePayload('holiday', h, name) });
  });
  if (spec.hours.length || spec.holidays.length) {
    items.push({ type: 'scheduleGroup', name: scheduleGroupName(spec), payload: null });
  }

  let done = 0;
  for (const it of items) {
    onProgress(`組織の状態を確認中… (${++done}/${items.length}) ${it.name}`);
    try {
      const found = await findByName(P[it.type], it.name);
      it.status = found ? 'exists' : 'create';
      it.id = found?.id || null;
    } catch (e) {
      it.status = 'error';
      it.error = e.message;
    }
  }
  if (spec.ivr.menu.length || spec.ivr.greeting) {
    items.push({ type: 'flow', name: `${spec.business.name}_着信フロー`, status: 'manual' });
  }
  return items;
}

/**
 * 「作成」の項目だけを実行する。items は確認時点で確定したもの(実行中に設計書が変わっても影響しない)。
 * 戻り値は各項目に result/error/id を書き込んだ配列。
 */
export async function executePlan(spec, items, onProgress = () => {}) {
  const targets = items.filter(i => i.status === 'create');
  let n = 0;
  for (const it of items) {
    if (it.status !== 'create') {
      it.result = it.status === 'exists' ? 'skipped' : it.status === 'manual' ? 'manual' : 'error';
      continue;
    }
    onProgress(`構築中… (${++n}/${targets.length}) ${TYPE_LABEL[it.type]}「${it.name}」`);
    try {
      let payload = it.payload;
      if (it.type === 'scheduleGroup') {
        const ids = role => items.filter(x => x.type === 'schedule' && x.role === role && x.id).map(x => ({ id: x.id }));
        const missing = items.filter(x => x.type === 'schedule' && !x.id);
        if (missing.length) throw new Error(`スケジュール(${missing.map(x => x.name).join('、')})が作成できていないため、グループを作りませんでした。`);
        payload = { name: it.name, timeZone: spec.timeZone, openSchedules: ids('open'), holidaySchedules: ids('holiday'), closedSchedules: [] };
        it.payload = payload;
      }
      const created = await gcWrite('POST', P[it.type], payload);
      if (!created?.id) throw new Error('作成の応答にIDが含まれていません。組織で作成されたか確認してください。');
      it.id = created.id;
      it.result = 'created';
    } catch (e) {
      it.result = 'error';
      it.error = e.message;
    }
  }
  return items;
}

function compareSchedule(actual, expected) {
  const diffs = [];
  const norm = v => String(v || '').replace(/\.\d+$/, '').replace(/Z$/, '');
  if (norm(actual.start) !== norm(expected.start)) diffs.push(`開始 ${actual.start} ≠ 設計 ${expected.start}`);
  if (norm(actual.end) !== norm(expected.end)) diffs.push(`終了 ${actual.end} ≠ 設計 ${expected.end}`);
  if ((actual.rrule || '') !== (expected.rrule || '')) diffs.push(`繰り返し ${actual.rrule || 'なし'} ≠ 設計 ${expected.rrule || 'なし'}`);
  return diffs;
}

/** 作成済み・既存の各要素を組織から取り直して、設計書どおりかを確認する */
export async function verifyPlan(spec, items, onProgress = () => {}) {
  const results = [];
  const scheduleIds = role => new Set(items.filter(x => x.type === 'schedule' && x.role === role && x.id).map(x => x.id));
  let n = 0;
  for (const it of items) {
    if (it.type === 'flow') {
      results.push({ type: it.type, name: it.name, ok: null, detail: 'Architectで手動構築(下の構築メモ参照)。テスト通話で確認してください。' });
      continue;
    }
    if (!it.id) {
      results.push({ type: it.type, name: it.name, ok: false, detail: '組織に存在しません(未作成または作成失敗)' });
      continue;
    }
    onProgress(`検証中… (${++n}) ${it.name}`);
    try {
      const actual = await gcGet(`${P[it.type]}/${encodeURIComponent(it.id)}`);
      const diffs = [];
      if (actual?.name !== it.name) diffs.push(`名前「${actual?.name}」`);
      if (it.type === 'schedule') diffs.push(...compareSchedule(actual, it.payload));
      if (it.type === 'scheduleGroup') {
        const idsOf = list => new Set((list || []).map(x => x.id));
        const eq = (a, b) => a.size === b.size && [...a].every(x => b.has(x));
        if (!eq(idsOf(actual.openSchedules), scheduleIds('open'))) diffs.push('営業時間スケジュールの組み合わせが設計と違います');
        if (!eq(idsOf(actual.holidaySchedules), scheduleIds('holiday'))) diffs.push('休業日スケジュールの組み合わせが設計と違います');
        if (actual.timeZone && actual.timeZone !== spec.timeZone) diffs.push(`タイムゾーン ${actual.timeZone} ≠ 設計 ${spec.timeZone}`);
      }
      results.push({ type: it.type, name: it.name, ok: diffs.length === 0, detail: diffs.length ? diffs.join(' / ') : '設計どおり' });
    } catch (e) {
      results.push({ type: it.type, name: it.name, ok: false, detail: `取得できませんでした: ${e.message}` });
    }
  }
  return results;
}

/** API で作れない着信フロー(IVR)を、Architectで手作業する時の手順メモにする */
export function flowBuildMemo(spec) {
  const lines = [];
  const act = a => !a ? '(未設定)' : a.action === 'queue' ? `キュー「${a.target}」へ転送` : a.action === 'message' ? `「${a.target}」を再生` : '切断';
  lines.push(`■ 着信フロー: ${spec.business.name}_着信フロー`);
  lines.push(`1. スケジュールの評価: スケジュールグループ「${scheduleGroupName(spec)}」`);
  lines.push(`   - 休業日 → 「${spec.ivr.holidayMessage || '(未設定)'}」を再生して切断`);
  lines.push(`   - 時間外 → 「${spec.ivr.afterHoursMessage || '(未設定)'}」を再生して切断`);
  lines.push(`2. 営業中: 「${spec.ivr.greeting || '(未設定)'}」を再生`);
  if (spec.ivr.menu.length) {
    lines.push('3. メニュー:');
    spec.ivr.menu.forEach(m => lines.push(`   - ${m.digit}: ${m.label} → ${act(m)}`));
    lines.push(`   - 無入力/該当なし → ${act(spec.ivr.noInput)}`);
  } else {
    lines.push(`3. → ${act(spec.ivr.noInput)}`);
  }
  return lines.join('\n');
}
