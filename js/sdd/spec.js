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
  "callRouting": { "numbers": ["+81312345678"] },
  "agents": [ { "email": "既存ユーザーのメールアドレス", "skills": [ { "name": "スキル名", "proficiency": 3 } ], "queues": ["所属させるキュー名"] } ],
  "dataTables": [ { "name": "表の名前", "description": "用途", "key": "キー列の名前", "columns": [ { "name": "列名", "type": "string|integer|number|boolean" } ], "rows": [ { "key": "キーの値", "列名": "値" } ] } ],
  "botFlows": [ { "name": "ボットフロー名", "question": "最初の問いかけ", "noMatch": "聞き取れなかった時の言い直し依頼", "intents": [ { "name": "意図名", "utterances": ["お客様が言いそうな言い方(3つ以上)"] } ] } ],
  "ava": [ {
    "name": "AVA(AIエージェント)名",
    "language": "ja-jp",
    "role": "誰の何を手伝うか・できないこと・お客様の呼び方(短い文で)",
    "instructions": ["会話全体で守るガイドライン(1文ずつ)"],
    "guardrails": ["止めたいお客様の振る舞い(例: 他社製品の価格を聞き出そうとする)"],
    "userExitMessage": "お客様が終了を希望した時の挨拶",
    "escalationMessage": "オペレーターにつなぐ時の言葉",
    "guardrailMessage": "範囲外の話題を断る言葉",
    "guardrailThreshold": 3,
    "guardrailCrossedMessage": "繰り返された時にオペレーターへつなぐ言葉"
  } ],
  "openQuestions": ["まだ決まっていないこと・確認したいこと"]
}`;

export function emptySpec(name = '') {
  return {
    business: { name, summary: '' },
    timeZone: 'Asia/Tokyo',
    hours: [], holidays: [], skills: [], wrapupCodes: [], queues: [],
    ivr: { greeting: '', menu: [], noInput: null, afterHoursMessage: '', holidayMessage: '' },
    callRouting: { numbers: [] }, agents: [], dataTables: [], botFlows: [], ava: [],
    openQuestions: []
  };
}

const str = v => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());
const strList = v => [...new Set((Array.isArray(v) ? v : []).map(str).filter(Boolean))];
const arr = v => (Array.isArray(v) ? v : []);
const COLUMN_TYPES = ['string', 'integer', 'number', 'boolean'];
export const AVA_LIMITS = { role: 5000, instructions: 50, instruction: 1000, guardrail: 4000 };
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
    callRouting: { numbers: strList(s.callRouting?.numbers).map(n => n.replace(/[\s-]/g, '')) },
    agents: arr(s.agents).map(a => ({
      email: str(a?.email).toLowerCase(),
      skills: arr(a?.skills).map(x => (typeof x === 'string' ? { name: str(x), proficiency: 3 } : { name: str(x?.name), proficiency: Number(x?.proficiency ?? 3) })).filter(x => x.name),
      queues: strList(a?.queues)
    })).filter(a => a.email),
    dataTables: arr(s.dataTables).map(t => ({
      name: str(t?.name), description: str(t?.description), key: str(t?.key) || 'キー',
      columns: arr(t?.columns).map(c => ({ name: str(c?.name), type: COLUMN_TYPES.includes(str(c?.type)) ? str(c.type) : 'string' })).filter(c => c.name),
      rows: arr(t?.rows).filter(r => r && typeof r === 'object' && !Array.isArray(r)).map(r => ({ ...r, key: str(r.key) }))
    })).filter(t => t.name),
    botFlows: arr(s.botFlows).map(b => ({
      name: str(b?.name), question: str(b?.question), noMatch: str(b?.noMatch),
      intents: arr(b?.intents).map(i => ({ name: str(i?.name), utterances: strList(i?.utterances) })).filter(i => i.name)
    })).filter(b => b.name),
    ava: arr(s.ava).map(a => ({
      name: str(a?.name), language: str(a?.language).toLowerCase() || 'ja-jp', role: str(a?.role),
      instructions: strList(a?.instructions), guardrails: strList(a?.guardrails),
      userExitMessage: str(a?.userExitMessage), escalationMessage: str(a?.escalationMessage),
      guardrailMessage: str(a?.guardrailMessage),
      guardrailThreshold: Number.isFinite(Number(a?.guardrailThreshold)) && a?.guardrailThreshold !== '' && a?.guardrailThreshold != null ? Number(a.guardrailThreshold) : 3,
      guardrailCrossedMessage: str(a?.guardrailCrossedMessage)
    })).filter(a => a.name),
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
  spec.ivr.menu.forEach(m => {
    if (m.digit === '*' || m.digit === '#') add('warn', `IVRメニュー「${m.label}」の「${m.digit}」は自動構築の対象外です(0〜9のみ作成します)。`);
  });
  if (spec.ivr.menu.length && spec.ivr.noInput && spec.ivr.noInput.action !== 'disconnect') {
    add('warn', 'メニューがある場合の「無入力時」は、Genesysの標準動作(メニューを繰り返した後に切断)になります。');
  }

  // 電話番号
  spec.callRouting.numbers.forEach(n => {
    if (!/^\+\d{8,15}$/.test(n)) add('error', `電話番号「${n}」は +81 から始まる国際形式(E.164)で書いてください(例: +81312345678)。`);
  });
  dupe(spec.callRouting.numbers, '電話番号');
  if (spec.callRouting.numbers.length && !spec.ivr.greeting && !spec.ivr.menu.length && !spec.ivr.noInput) {
    add('error', '電話番号を割り当てるには、着信フロー(アナウンスやメニュー)を設計してください。');
  }

  // エージェント
  const emails = new Set();
  spec.agents.forEach(a => {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a.email)) add('error', `エージェント「${a.email}」のメールアドレスの形式が正しくありません。`);
    if (emails.has(a.email)) add('error', `エージェント「${a.email}」が重複しています。`);
    emails.add(a.email);
    a.skills.forEach(k => {
      if (!(k.proficiency >= 0 && k.proficiency <= 5)) add('error', `${a.email} のスキル「${k.name}」の習熟度は0〜5で指定してください。`);
      if (!skillNames.has(k.name)) add('warn', `${a.email} に付けるスキル「${k.name}」は設計のスキル一覧にありません(組織に既にある場合だけ付与できます)。`);
    });
    a.queues.forEach(q => { if (!queueNames.has(q)) add('warn', `${a.email} を入れるキュー「${q}」は設計にありません(組織に既にある場合だけ追加できます)。`); });
  });

  // データテーブル
  dupe(spec.dataTables.map(t => t.name), 'データテーブル');
  spec.dataTables.forEach(t => {
    if (!t.columns.length) add('warn', `データテーブル「${t.name}」にキー以外の列がありません。`);
    const cols = new Set(t.columns.map(c => c.name));
    if (cols.has(t.key) || t.key === 'key') add('error', `データテーブル「${t.name}」の列名にキー列と同じ名前があります。`);
    dupe(t.columns.map(c => c.name), `データテーブル「${t.name}」の列`);
    const keys = new Set();
    t.rows.forEach((r, i) => {
      if (!r.key) add('error', `データテーブル「${t.name}」の${i + 1}行目のキーが空です。`);
      if (keys.has(r.key)) add('error', `データテーブル「${t.name}」のキー「${r.key}」が重複しています。`);
      keys.add(r.key);
      Object.keys(r).filter(k => k !== 'key' && !cols.has(k)).forEach(k => add('error', `データテーブル「${t.name}」の行に、列にない項目「${k}」があります。`));
    });
  });

  // ボットフロー
  dupe(spec.botFlows.map(b => b.name), 'ボットフロー');
  spec.botFlows.forEach(b => {
    if (!b.intents.length) add('error', `ボットフロー「${b.name}」に意図(インテント)がありません。`);
    if (!b.question) add('warn', `ボットフロー「${b.name}」の最初の問いかけが未設定です。`);
    dupe(b.intents.map(i => i.name), `ボットフロー「${b.name}」の意図`);
    b.intents.forEach(i => { if (i.utterances.length < 3) add('warn', `ボットフロー「${b.name}」の意図「${i.name}」の言い方が${i.utterances.length}件です(3件以上あると聞き分けが安定します)。`); });
  });

  // AVA
  dupe(spec.ava.map(a => a.name), 'AVA');
  spec.ava.forEach(a => {
    const w = `AVA「${a.name}」`;
    if (!a.role) add('error', `${w}の役割(role)が未設定です。`);
    else if (a.role.length > AVA_LIMITS.role) add('error', `${w}の役割が${AVA_LIMITS.role}文字を超えています。`);
    if (!a.instructions.length) add('error', `${w}のガイドライン(instructions)が1つもありません。`);
    if (a.instructions.length > AVA_LIMITS.instructions) add('error', `${w}のガイドラインが${AVA_LIMITS.instructions}件を超えています。`);
    a.instructions.forEach((t, i) => { if (t.length > AVA_LIMITS.instruction) add('error', `${w}のガイドライン${i + 1}が${AVA_LIMITS.instruction}文字を超えています。`); });
    a.guardrails.forEach((t, i) => { if (t.length > AVA_LIMITS.guardrail) add('error', `${w}のガードレール${i + 1}が長すぎます。`); });
    if (!(Number.isInteger(a.guardrailThreshold) && a.guardrailThreshold >= 1 && a.guardrailThreshold <= 10)) add('error', `${w}のガードレールの回数は1〜10の整数にしてください。`);
    if (!a.escalationMessage) add('warn', `${w}のオペレーターにつなぐ時の言葉が未設定です。`);
    if (/^(you are a helpful assistant|あなたは(親切な|役に立つ)?アシスタントです)/i.test(a.role)) add('warn', `${w}の役割が一般的すぎます。対象・できること・できないことを書いてください(AVA公式ガイドより)。`);
  });

  if (spec.queues.length && !spec.wrapupCodes.length) add('warn', '後処理コードが1つもありません(応対結果の集計ができません)。');
  spec.openQuestions.forEach(q => add('warn', `未決事項: ${q}`));
  return issues;
}

/** 2つの版の差分を、名前の追加/削除/変更で表す(変更依頼の確認用) */
export function diffSpecs(before, after) {
  const out = [];
  const byName = (list, key = 'name') => new Map((list || []).map(x => [typeof x === 'string' ? x : x[key], x]));
  const cmp = (label, a, b, key = 'name') => {
    const A = byName(a, key), B = byName(b, key);
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
  cmp('電話番号', before?.callRouting?.numbers, after.callRouting.numbers);
  cmp('エージェント', before?.agents, after.agents, 'email');
  cmp('データテーブル', before?.dataTables, after.dataTables);
  cmp('ボットフロー', before?.botFlows, after.botFlows);
  cmp('AVA', before?.ava, after.ava);
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
