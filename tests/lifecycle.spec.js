/* ヒアリング → 設計 → 構築 → テスト → 評価 → 変更(v2) の一連の流れ */
const { launch, seedConnected, assert, mockGenesys } = require('./helpers');

exports.name = '業務プロジェクトのライフサイクル';

const SPEC = {
  business: { name: '会員サポート', summary: '会員からの問い合わせ窓口' },
  timeZone: 'Asia/Tokyo',
  hours: [{ name: '平日営業', days: ['MO', 'TU', 'WE', 'TH', 'FR'], open: '09:00', close: '18:00' }],
  holidays: [{ name: '年末休業', date: '2026-12-31' }],
  skills: ['解約対応'],
  wrapupCodes: ['解決', '折り返し'],
  queues: [{ name: '会員_登録変更', description: '登録変更', skills: [] }, { name: '会員_解約', description: '解約相談', skills: ['解約対応'] }],
  ivr: {
    greeting: 'お電話ありがとうございます',
    menu: [{ digit: '1', label: '登録変更', action: 'queue', target: '会員_登録変更' }, { digit: '2', label: '解約', action: 'queue', target: '会員_解約' }],
    noInput: { action: 'queue', target: '会員_登録変更' },
    afterHoursMessage: '営業時間外です', holidayMessage: '本日は休業日です'
  },
  openQuestions: []
};

exports.run = async () => {
  const { page, url, errors, close } = await launch();
  try {
    const aiCalls = [];
    await page.route('https://api.anthropic.com/v1/messages', async route => {
      const req = route.request();
      const body = JSON.parse(req.postData());
      aiCalls.push({ headers: req.headers(), body });
      const last = body.messages[body.messages.length - 1].content;
      let text = 'ありがとうございます。営業時間を教えてください。';
      if (body.system.includes('設計書の作成')) text = '```json\n' + JSON.stringify(body.system.includes('既存の設計書') ? { ...SPEC, wrapupCodes: [...SPEC.wrapupCodes, '要対応'] } : SPEC) + '\n```';
      if (body.system.includes('テストシナリオ')) text = '```json\n{"cases":[{"title":"平日10時に2","date":"2026-12-01","time":"10:00","digit":"2","expected":"キュー「会員_解約」"},{"title":"休業日","date":"2026-12-31","time":"10:00","digit":"","expected":"休業アナウンス"}]}\n```';
      if (body.system.includes('評価')) text = '## 総合評価\n概ね良好\n## 観点別スコア\n- 要件の網羅性 — 4/5 — 良い';
      assert(typeof last === 'string', 'messages content is string');
      await route.fulfill({ json: { content: [{ type: 'text', text }], stop_reason: 'end_turn' } });
    });

    const store = await mockGenesys(page);
    // 既存のキューが1つある(上書きしないことを確認する)
    store.queues.push({ id: 'q-existing', name: '会員_登録変更' });
    const created = () => store.writes.filter(w => w.startsWith('POST'));

    await seedConnected(page, url);
    await page.waitForSelector('.hero');

    // プロジェクト作成
    await page.click('[data-act="new"]');
    await page.fill('form [name="name"]', '会員サポート');
    await page.click('form button[type="submit"]');
    await page.waitForSelector('#chatInput');

    // ヒアリング
    const toSpecDisabled = await page.$eval('#toSpecBtn', b => b.disabled);
    assert(toSpecDisabled, '会話前は設計書作成ボタンが押せない');
    await page.fill('#chatInput', '平日9時から18時の会員窓口です');
    await page.click('#sendBtn');
    await page.waitForSelector('.msg-assistant');
    const h = aiCalls[0].headers;
    assert(h['anthropic-dangerous-direct-browser-access'] === 'true', 'ブラウザ直接アクセスのヘッダ');
    assert(h['x-api-key'] === 'sk-ant-test', 'APIキーを送る');
    assert(aiCalls[0].body.model === 'claude-opus-5-5', 'モデル');

    // 設計書作成 → 設計画面
    await page.click('#toSpecBtn');
    await page.waitForSelector('#commitBtn');
    assert(await page.isVisible('text=設計書の案'), '案として表示');
    // シミュレーター
    await page.fill('#simDate', '2026-12-01');
    await page.fill('#simTime', '10:00');
    await page.fill('#simDigit', '2');
    await page.click('#simRun');
    assert((await page.textContent('#simOut')).includes('会員_解約'), 'シミュレーターが解約キューへ');
    await page.fill('#simDate', '2026-12-31');
    await page.click('#simRun');
    assert((await page.textContent('#simOut')).includes('休業日'), 'シミュレーターが休業日を判定');

    await page.click('#commitBtn');
    await page.waitForSelector('text=設計書 v1');

    // 構築
    await page.click('.step[data-phase="build"]');
    await page.waitForSelector('#planBtn');
    assert(await page.$eval('#runBtn', b => b.disabled), '計画前は実行できない');
    await page.click('#planBtn');
    await page.waitForSelector('text=件を新しく作成します');
    const planText = await page.textContent('#planArea');
    assert(planText.includes('既存(触らない)'), '既存キューは触らない計画');
    assert(planText.includes('会員サポート_着信_営業時間内') && planText.includes('会員サポート_着信_休業日'), '着信フロー3本を作る計画');
    assert(!planText.includes('手作業'), '電話番号もボットも無いので手作業は無い');
    await page.click('#runBtn');
    await page.waitForSelector('.modal');
    await page.click('.modal [data-act="ok"]');
    await page.waitForSelector('#resultArea .badge-success', { timeout: 60000 });
    assert(store.queues.filter(q => q.name === '会員_登録変更').length === 1, '既存キューを作り直さない');
    assert(store.queues.some(q => q.name === '会員_解約'), '新しいキューを作る');
    assert(store.schedulegroups.some(g => g.name === '会員サポート_営業時間'), 'スケジュールグループを作る');
    assert(store.flows.length === 3 && store.flows.every(f => f.publishedVersion), '着信フロー3本を公開');
    const openFlow = store.flows.find(f => f.name === '会員サポート_着信_営業時間内').yaml;
    assert(openFlow.includes('menuTransferToAcd') && openFlow.includes('"digit_2"') && openFlow.includes('"会員_解約"'), `メニューが転送になっている: ${openFlow}`);
    assert(created().length > 0, '書き込みがある');
    const grp = store.schedulegroups[0];
    assert(grp.openSchedules.length === 1 && grp.holidaySchedules.length === 1, 'グループに営業/休業スケジュールを入れる');
    const sch = store.schedules.find(s => s.name === '会員サポート_平日営業');
    assert(sch.rrule === 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' && sch.start === '2024-01-01T09:00:00.000', 'スケジュールのペイロード');

    // テスト
    await page.click('#toTest');
    await page.click('#verifyBtn');
    await page.waitForSelector('#verifyArea table');
    const vText = await page.textContent('#verifyArea');
    assert(vText.includes('不一致 0'), `検証がすべて一致: ${vText}`);
    await page.click('#genCases');
    await page.waitForSelector('[data-case]');
    assert((await page.$$('[data-case]')).length === 2, 'シナリオ2件');
    await page.selectOption('[data-case] select', 'pass');
    await page.waitForSelector('text=合格 1');

    // 評価
    await page.click('#toEval');
    await page.click('#evalBtn');
    await page.waitForSelector('.eval-body');
    assert((await page.textContent('.eval-body')).includes('概ね良好'), '評価表示');

    // 変更 → v2
    await page.click('#toChange');
    await page.fill('#chatInput', '後処理コードに「要対応」を追加したい');
    await page.click('#sendBtn');
    await page.waitForFunction(() => document.querySelectorAll('.msg-assistant').length === 2);
    await page.click('#toSpecBtn');
    await page.waitForSelector('.diff');
    assert((await page.textContent('.diff')).includes('追加 後処理コード「要対応」'), '差分表示');
    await page.click('#commitBtn');
    await page.waitForSelector('text=設計書 v2');

    // 再読み込みしても残る(IndexedDB)
    await page.reload();
    await page.waitForSelector('text=設計書 v2');

    assert(!errors.length, `コンソールエラー: ${errors.join(' | ')}`);
  } finally {
    await close();
  }
};
