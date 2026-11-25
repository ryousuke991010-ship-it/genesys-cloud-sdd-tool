/* 業務の設計書(スペック) — Spec-Driven Development の中心
 *
 * 会話(ヒアリング)→ この設計書 → 構築 → テスト → 評価、の全工程がこの1つのJSONを基準に動く。
 * 変更があった時も「会話で伝える → 設計書の新しい版を作る → 差分だけ構築する」の順で進める。
 */

export const DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
export const DAY_LABEL = { MO: '月', TU: '火', WE: '水', TH: '木', FR: '金', SA: '土', SU: '日' };

/** AIに渡す設計書の形(このまま説明としてプロンプトに入れる) */
export const SPEC_SCHEMA_TEXT = `{
  "business": { "name": "業務名", "summary": "1〜3文の業務概要" },
  "timeZone": "Asia/Tokyo",
  "hours": [ { "name": "平日営業", "days": ["MO","TU","WE","TH","FR"], "open": "09:00", "close": "18:00" } ],
  "holidays": [ { "name": "年末休業", "date": "2026-12-31" } ],
  "skills": ["ACDスキル名"],
  "wrapupCodes": ["後処理コード名"],
  "queues": [ { "name": "キュー名", "description": "役割", "skills": ["このキューで必要なスキル名"] } ],
  "ivr": {
    "greeting": "冒頭アナウンス",
    "menu": [ { "digit": "1", "label": "メニュー名", "action": "queue|message|disconnect", "target": "キュー名 または 読み上げ文" } ],
    "noInput": { "action": "queue|message|disconnect", "target": "キュー名 または 読み上げ文" },
    "afterHoursMessage": "営業時間外アナウンス",
    "holidayMessage": "休業日アナウンス"
  },
  "openQuestions": ["まだ決まっていないこと・確認したいこと"]
}`;

export function emptySpec(name = '') {
  return {
    business: { name, summary: '' },
    timeZone: 'Asia/Tokyo',
    hours: [], holidays: [], skills: [], wrapupCodes: [], queues: [],
    ivr: { greeting: '', menu: [], noInput: null, afterHoursMessage: '', holidayMessage: '' },
    openQuestions: []
  };
}

const str = v => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());
const strList = v => [...new Set((Array.isArray(v) ? v : []).map(str).filter(Boolean))];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function normTime(v) {
  const s = str(v);
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : s;
}

function normAction(a) {
  if (!a || typeof a !== 'object') return null;
  const action = ['queue', 'message', 'disconnect'].includes(a.action) ? a.action : 'message';
  return { action, target: str(a.target) };
}

/** AIが返した設計書を、欠けや揺れがあっても扱える形にそろえる(不正値は捨てずに検査で指摘する) */
export function normalizeSpec(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const ivr = s.ivr && typeof s.ivr === 'object' ? s.ivr : {};
  return {
    business: { name: str(s.business?.name), summary: str(s.business?.summary) },
    timeZone: str(s.timeZone) || 'Asia/Tokyo',
    hours: (Array.isArray(s.hours) ? s.hours : []).map(h => ({
      name: str(h?.name),
      days: (Array.isArray(h?.days) ? h.days : []).map(d => str(d).toUpperCase()).filter(d => DAYS.includes(d)),
      open: normTime(h?.open),
      close: normTime(h?.close)
    })),
    holidays: (Array.isArray(s.holidays) ? s.holidays : []).map(h => ({ name: str(h?.name), date: str(h?.date) })),
    skills: strList(s.skills),
    wrapupCodes: strList(s.wrapupCodes),
    queues: (Array.isArray(s.queues) ? s.queues : []).map(q => ({
      name: str(q?.name), description: str(q?.description), skills: strList(q?.skills)
    })).filter(q => q.name),
    ivr: {
      greeting: str(ivr.greeting),
      menu: (Array.isArray(ivr.menu) ? ivr.menu : []).map(m => ({
        digit: str(m?.digit), label: str(m?.label), ...normAction(m)
      })),
      noInput: normAction(ivr.noInput),
      afterHoursMessage: str(ivr.afterHoursMessage),
      holidayMessage: str(ivr.holidayMessage)
    },
    openQuestions: strList(s.openQuestions)
  };
}

/**
 * 設計書の機械的な検査。AIの評価とは別に、必ず同じ結果になる確認をする。
 * level: error = 構築できない / warn = 構築はできるが運用で困る
 */
export function lintSpec(spec) {
  const issues = [];
  const add = (level, text) => issues.push({ level, text });
  const queueNames = new Set(spec.queues.map(q => q.name));
  const skillNames = new Set(spec.skills);

  if (!spec.business.name) add('error', '業務名が未設定です。');
  if (!spec.hours.length) add('warn', '営業時間が未設定です(24時間受付の場合もその旨を設計に書いてください)。');
  spec.hours.forEach((h, i) => {
    const label = h.name || `営業時間${i + 1}`;
    if (!h.name) add('error', `${i + 1}番目の営業時間に名前がありません。`);
    if (!h.days.length) add('error', `「${label}」の曜日が未設定です。`);
    if (!TIME_RE.test(h.open) || !TIME_RE.test(h.close)) add('error', `「${label}」の時刻はHH:MM形式で指定してください(${h.open}〜${h.close})。`);
    else if (h.open >= h.close) add('error', `「${label}」の終了時刻が開始時刻以前です(日をまたぐ営業時間は2つに分けてください)。`);
  });
  spec.holidays.forEach((h, i) => {
    if (!h.name) add('error', `${i + 1}番目の休業日に名前がありません。`);
    if (!DATE_RE.test(h.date) || Number.isNaN(new Date(`${h.date}T00:00:00`).getTime())) add('error', `休業日「${h.name || i + 1}」の日付はYYYY-MM-DD形式で指定してください。`);
  });
  const dupe = (list, label) => {
    const seen = new Set();
    list.forEach(n => { if (seen.has(n)) add('error', `${label}「${n}」が重複しています。`); seen.add(n); });
  };
  dupe(spec.hours.map(h => h.name).filter(Boolean), '営業時間');
  dupe(spec.holidays.map(h => h.name).filter(Boolean), '休業日');
  dupe(spec.queues.map(q => q.name), 'キュー');

  spec.queues.forEach(q => q.skills.forEach(s => {
    if (!skillNames.has(s)) add('warn', `キュー「${q.name}」が使うスキル「${s}」がスキル一覧にありません。`);
  }));

  const checkAction = (a, where) => {
    if (!a) return;
    if (a.action === 'queue' && !queueNames.has(a.target)) add('error', `${where}の転送先キュー「${a.target}」が設計にありません。`);
    if (a.action === 'message' && !a.target) add('warn', `${where}の読み上げ文が空です。`);
  };
  const digits = new Set();
  spec.ivr.menu.forEach((m, i) => {
    const where = `IVRメニュー「${m.label || m.digit || i + 1}」`;
    if (!/^[0-9*#]$/.test(m.digit)) add('error', `${where}のダイヤル番号は0〜9・*・#の1文字にしてください。`);
    if (digits.has(m.digit)) add('error', `IVRメニューのダイヤル番号「${m.digit}」が重複しています。`);
    digits.add(m.digit);
    checkAction(m, where);
  });
  checkAction(spec.ivr.noInput, '無入力時');
  if (spec.ivr.menu.length && !spec.ivr.noInput) add('warn', '番号が押されなかった時の動き(無入力時)が未設定です。');
  if (spec.hours.length && !spec.ivr.afterHoursMessage) add('warn', '営業時間外のアナウンスが未設定です。');
  if (spec.holidays.length && !spec.ivr.holidayMessage) add('warn', '休業日のアナウンスが未設定です。');
  if (spec.queues.length && !spec.wrapupCodes.length) add('warn', '後処理コードが1つもありません(応対結果の集計ができません)。');
  spec.openQuestions.forEach(q => add('warn', `未決事項: ${q}`));
  return issues;
}

/** 2つの版の差分を、名前の追加/削除/変更で表す(変更依頼の確認用) */
export function diffSpecs(before, after) {
  const out = [];
  const byName = (list, key = 'name') => new Map((list || []).map(x => [typeof x === 'string' ? x : x[key], x]));
  const cmp = (label, a, b) => {
    const A = byName(a), B = byName(b);
    for (const [n, v] of B) {
      if (!A.has(n)) out.push({ kind: 'add', label, name: n });
      else if (JSON.stringify(A.get(n)) !== JSON.stringify(v)) out.push({ kind: 'change', label, name: n });
    }
    for (const n of A.keys()) if (!B.has(n)) out.push({ kind: 'remove', label, name: n });
  };
  cmp('営業時間', before?.hours, after.hours);
  cmp('休業日', before?.holidays, after.holidays);
  cmp('スキル', before?.skills, after.skills);
  cmp('後処理コード', before?.wrapupCodes, after.wrapupCodes);
  cmp('キュー', before?.queues, after.queues);
  if (JSON.stringify(before?.ivr) !== JSON.stringify(after.ivr)) out.push({ kind: 'change', label: 'IVR', name: '着信フロー' });
  if (before?.timeZone !== after.timeZone) out.push({ kind: 'change', label: 'タイムゾーン', name: after.timeZone });
  return out;
}

/* ---- 設計どおりに着信が流れるかのシミュレーター(組織に触らず検証できる) ---- */

/** dateStr: 'YYYY-MM-DD' / timeStr: 'HH:MM' / digit: 押す番号(空=無入力) */
export function simulateCall(spec, { date, time, digit }) {
  const steps = [];
  const d = new Date(`${date}T00:00:00`);
  if (Number.isNaN(d.getTime()) || !TIME_RE.test(time)) return { steps: ['日時の指定が正しくありません'], result: 'error' };
  const day = DAYS[(d.getDay() + 6) % 7];
  steps.push(`${date}(${DAY_LABEL[day]}) ${time} に着信`);

  const holiday = spec.holidays.find(h => h.date === date);
  if (holiday) {
    steps.push(`休業日「${holiday.name}」に該当`);
    steps.push(`アナウンス: ${spec.ivr.holidayMessage || '(未設定)'}`);
    return { steps, result: 'holiday' };
  }
  const open = spec.hours.find(h => h.days.includes(day) && h.open <= time && time < h.close);
  if (spec.hours.length && !open) {
    steps.push('営業時間外');
    steps.push(`アナウンス: ${spec.ivr.afterHoursMessage || '(未設定)'}`);
    return { steps, result: 'afterHours' };
  }
  if (open) steps.push(`営業時間「${open.name}」(${open.open}〜${open.close})内`);
  if (spec.ivr.greeting) steps.push(`アナウンス: ${spec.ivr.greeting}`);

  let action;
  if (!spec.ivr.menu.length) {
    action = spec.ivr.noInput;
  } else if (!digit) {
    steps.push('番号の入力なし');
    action = spec.ivr.noInput;
  } else {
    const m = spec.ivr.menu.find(x => x.digit === digit);
    if (!m) {
      steps.push(`「${digit}」はメニューにない番号`);
      action = spec.ivr.noInput;
    } else {
      steps.push(`「${digit}」${m.label} を選択`);
      action = m;
    }
  }
  if (!action) {
    steps.push('次の動きが設計されていません');
    return { steps, result: 'undefined' };
  }
  if (action.action === 'queue') steps.push(`キュー「${action.target}」へ転送`);
  else if (action.action === 'message') steps.push(`アナウンス: ${action.target}`);
  else steps.push('切断');
  return { steps, result: action.action, target: action.target };
}
