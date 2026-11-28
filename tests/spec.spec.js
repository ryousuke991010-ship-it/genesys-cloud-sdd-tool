/* 設計書の正規化・検査・シミュレーター(ブラウザでモジュールを直接読む) */
const { launch, assert } = require('./helpers');

exports.name = '設計書の検査とシミュレーター';

exports.run = async () => {
  const { page, url, errors, close } = await launch();
  try {
    await page.goto(url);
    const r = await page.evaluate(async () => {
      const m = await import('./js/sdd/spec.js');
      const spec = m.normalizeSpec({
        business: { name: 'X' },
        hours: [{ name: '平日', days: ['mo', 'TU'], open: '9:00', close: '18:00' }, { name: '逆', days: ['SA'], open: '18:00', close: '09:00' }],
        queues: [{ name: 'A' }],
        ivr: { menu: [{ digit: '1', label: 'a', action: 'queue', target: 'B' }, { digit: '1', label: 'b', action: 'message', target: '' }] }
      });
      const issues = m.lintSpec(spec).map(i => i.level + ':' + i.text);
      const after = m.simulateCall(spec, { date: '2026-12-05', time: '10:00', digit: '' }); // 土曜
      const open = m.simulateCall(spec, { date: '2026-12-01', time: '09:00', digit: '9' }); // 火曜
      const s2 = m.normalizeSpec({
        business: { name: 'Y' },
        callRouting: { numbers: ['03-1234-5678'] },
        agents: [{ email: 'bad', skills: [{ name: 'Z', proficiency: 9 }] }],
        dataTables: [{ name: 'T', key: 'k', columns: [{ name: 'c' }], rows: [{ key: '' }, { key: 'a', x: 1 }] }],
        botFlows: [{ name: 'B', intents: [] }],
        ava: [{ name: 'A', role: 'あなたは親切なアシスタントです', instructions: [], guardrailThreshold: 20 }]
      });
      const issues2 = m.lintSpec(s2).map(i => i.level + ':' + i.text);
      return { hours: spec.hours[0], issues, after: after.result, open: open.steps, issues2 };
    });
    const has = (t, level = 'error') => r.issues2.some(i => i.startsWith(level + ':') && i.includes(t));
    assert(has('国際形式'), '電話番号の形式');
    assert(has('着信フロー(アナウンスやメニュー)を設計'), 'フロー無しの番号割り当て');
    assert(has('メールアドレスの形式') && has('習熟度は0〜5'), 'エージェントの検査');
    assert(has('行目のキーが空') && has('列にない項目「x」'), 'データテーブルの検査');
    assert(has('意図(インテント)がありません'), 'ボットフローの検査');
    assert(has('ガイドライン(instructions)が1つもありません') && has('1〜10の整数') && has('一般的すぎ', 'warn'), 'AVAの検査');
    assert(r.hours.open === '09:00' && r.hours.days.join() === 'MO,TU', '時刻・曜日の正規化');
    assert(r.issues.some(i => i.startsWith('error:') && i.includes('終了時刻')), '逆転した時刻を検出');
    assert(r.issues.some(i => i.includes('転送先キュー「B」')), '存在しないキューを検出');
    assert(r.issues.some(i => i.includes('ダイヤル番号「1」が重複')), '番号重複を検出');
    assert(r.after === 'afterHours', '土曜10時は時間外');
    assert(r.open.some(s => s.includes('メニューにない番号')), 'メニューにない番号');
    assert(!errors.length, errors.join(' | '));
  } finally {
    await close();
  }
};
