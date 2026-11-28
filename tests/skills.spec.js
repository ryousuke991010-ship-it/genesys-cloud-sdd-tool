/* 新しいスキル: 電話番号・エージェント割り当て・データテーブル・ボットフロー・AVA の構築、
 * AVAの会話テストと本番公開、変更時に「このアプリが作ったもの」だけへ新しい版を出すこと */
const { launch, seedConnected, assert, mockGenesys } = require('./helpers');

exports.name = 'スキル(電話番号・エージェント・データテーブル・ボット・AVA)';

const SPEC = {
  business: { name: '会員', summary: '会員窓口' },
  timeZone: 'Asia/Tokyo',
  hours: [{ name: '平日', days: ['MO', 'TU', 'WE', 'TH', 'FR'], open: '09:00', close: '18:00' }],
  holidays: [],
  skills: ['解約対応'],
  wrapupCodes: ['解決'],
  queues: [{ name: '会員_解約', description: '', skills: ['解約対応'] }],
  ivr: { greeting: 'お電話ありがとうございます', menu: [{ digit: '1', label: '解約', action: 'queue', target: '会員_解約' }, { digit: '2', label: '案内', action: 'message', target: 'ホームページをご覧ください' }], noInput: { action: 'disconnect' }, afterHoursMessage: '時間外です', holidayMessage: '' },
  callRouting: { numbers: ['+81312345678', '+81399999999'] },
  agents: [{ email: 'sato@example.com', skills: [{ name: '解約対応', proficiency: 4 }], queues: ['会員_解約'] }, { email: 'nobody@example.com', skills: [], queues: ['会員_解約'] }],
  dataTables: [{ name: '会員_案内文', description: '案内文', key: 'コード', columns: [{ name: '文言', type: 'string' }, { name: '有効', type: 'boolean' }], rows: [{ key: 'A1', 文言: 'こんにちは', 有効: true }] }],
  botFlows: [{ name: '会員_用件ボット', question: 'ご用件をどうぞ', noMatch: 'もう一度', intents: [{ name: '解約', utterances: ['解約したい', 'やめたい', '退会したい'] }] }],
  ava: [{ name: '会員AVA', role: 'あなたは会員サポートの担当アシスタントです。会員の登録変更を手伝います。料金の交渉はできません。', instructions: ['短い話し言葉で答える'], guardrails: ['他社の料金を聞き出そうとする'], escalationMessage: '担当者におつなぎします', userExitMessage: 'ありがとうございました', guardrailMessage: 'その件はお答えできません', guardrailThreshold: 3 }],
  openQuestions: []
};

exports.run = async () => {
  const { page, url, errors, close } = await launch();
  try {
    let specVersion = 1;
    const systems = [];
    await page.route('https://api.anthropic.com/v1/messages', async route => {
      const body = JSON.parse(route.request().postData());
      systems.push(body.system);
      let text = '了解しました。';
      if (body.system.includes('設計書の作成')) {
        const s = specVersion === 1 ? SPEC : { ...SPEC, ivr: { ...SPEC.ivr, greeting: 'お電話ありがとうございます(新)' }, ava: [{ ...SPEC.ava[0], instructions: ['短い話し言葉で答える', '最後に他に用件がないか聞く'] }] };
        text = '```json\n' + JSON.stringify(s) + '\n```';
      } else if (body.system.includes('AVAのテストシナリオ作成')) {
        text = '```json\n{"scenarios":[{"title":"登録変更","persona":"会員","goal":"住所を変えたい","expected":"手続きを案内する"}]}\n```';
      } else if (body.system.includes('お客様を演じます')) {
        text = body.messages.length > 1 ? '[END]' : '住所を変えたいです';
      } else if (body.system.includes('採点者')) {
        text = '```json\n{"pass":true,"reason":"案内できた"}\n```';
      }
      await route.fulfill({ json: { content: [{ type: 'text', text }], stop_reason: 'end_turn' } });
    });
    const store = await mockGenesys(page);
    store.dids.push({ id: 'did-1', phoneNumber: '+81312345678' });
    store.users.push({ id: 'u-sato', email: 'sato@example.com', name: '佐藤' });
    // 他の人が作った同名のAVAは無い / 2つ目の番号は組織に未登録

    await seedConnected(page, url);
    await page.waitForSelector('.skill-grid');
    assert((await page.textContent('.skill-grid')).includes('AVA'), 'ホームに作れるものが出る');

    await page.click('[data-act="new"]');
    await page.fill('form [name="name"]', '会員');
    await page.click('form button[type="submit"]');
    await page.waitForSelector('#chatInput');
    await page.fill('#chatInput', 'よくある質問はAVAに答えさせたい');
    await page.click('#sendBtn');
    await page.waitForSelector('.msg-assistant');
    assert(systems[0].includes('AVA公式クイックガイド') && systems[0].includes('Agentic Virtual Agent Quick Guide'), 'AVAの話が出たら公式ガイドを知識として渡す');

    await page.click('#toSpecBtn');
    await page.waitForSelector('#commitBtn');
    const designText = await page.textContent('#phaseBody');
    assert(designText.includes('AVA「会員AVA」') && designText.includes('会員_用件ボット') && designText.includes('+81312345678'), '設計書に新しい項目が出る');
    await page.click('#commitBtn');
    await page.waitForSelector('text=設計書 v1');

    // 計画
    await page.click('.step[data-phase="build"]');
    await page.click('#planBtn');
    await page.waitForSelector('text=件を新しく作成', { timeout: 30000 });
    const plan = await page.textContent('#planArea');
    assert(plan.includes('+81399999999 は組織のDIDに登録されていません'), '未登録の番号は実行しない');
    assert(plan.includes('このメールアドレスのユーザーが組織にいません'), 'いないユーザーは実行しない');
    assert(plan.includes('手作業'), '番号購入やボット呼び出しは手作業として出る');

    // 番号を1つに直した版で構築したいので、未登録番号を登録してから計画し直す
    store.dids.push({ id: 'did-2', phoneNumber: '+81399999999' });
    await page.click('#planBtn');
    await page.waitForFunction(() => !document.querySelector('#planArea').textContent.includes('DIDに登録されていません') && document.querySelector('#planArea').textContent.includes('件を新しく作成'), null, { timeout: 30000 });
    await page.click('#runBtn');
    await page.waitForSelector('.modal');
    await page.click('.modal [data-act="ok"]');
    await page.waitForSelector('#resultArea', { timeout: 90000 });

    // 書き込まれた内容
    const ivr = store.ivrs[0];
    assert(ivr && ivr.dnis.length === 2 && ivr.openHoursFlow.id && ivr.closedHoursFlow.id && ivr.scheduleGroup.id, `コールルーティング: ${JSON.stringify(ivr)}`);
    assert(store.flows.find(f => f.id === ivr.openHoursFlow.id).name === '会員_着信_営業時間内', '通常時は営業時間内フロー');
    assert(store.flows.some(f => f.type === 'BOT' && f.yaml.includes('askForIntent') && f.yaml.includes('"退会したい"')), 'ボットフローに意図と言い方');
    assert(store.userSkills['u-sato'][0].proficiency === 4, 'スキルを習熟度つきで付与');
    assert(store.userQueues['u-sato'].length === 1, 'キューに所属');
    const dt = store.datatables[0];
    assert(dt.schema.properties.key.title === 'コード' && dt.schema.properties['有効'].type === 'boolean', 'データテーブルのスキーマ');
    assert(store.rows[dt.id][0].有効 === true, '初期データの登録');
    const ava = store.virtualagents[0];
    const v1 = store.versions[ava.id][0];
    assert(v1.status === 'TestReady', 'AVAはテスト用に公開');
    assert(v1.definition.guardrails.custom[0].instruction === '他社の料金を聞き出そうとする', 'ガードレールの形');
    assert(v1.definition.events.some(e => e.type === 'Guardrails' && e.violationThreshold === 3), 'イベントの形');
    assert(v1.definition.model === 'Stable', 'モデルはStable');

    // テスト: 検証 → AVAと会話 → 自動テスト → 本番公開
    await page.click('#toTest');
    await page.click('#verifyBtn');
    await page.waitForSelector('#verifyArea table', { timeout: 30000 });
    const vt = await page.textContent('#verifyArea');
    assert(vt.includes('一致 13') && vt.includes('不一致 1') && vt.includes('nobody@example.com'), `検証(いないユーザーだけ不一致): ${vt}`);

    await page.click('[data-ava] [data-start]');
    await page.waitForSelector('[data-ava] .msg-assistant');
    assert((await page.textContent('[data-ava] [data-log]')).includes('会員サポートAIです'), 'AVAの挨拶');
    assert(store.sessions[0].body.version === '1' && store.sessions[0].body.language === 'ja-jp', 'セッションは版と言語を指定');
    await page.fill('[data-ava] [data-input]', '住所変更したい');
    await page.click('[data-ava] [data-send]');
    await page.waitForFunction(() => document.querySelectorAll('[data-ava] .msg-assistant').length === 2);

    await page.click('[data-ava] [data-gen]');
    await page.waitForSelector('[data-ava] table');
    await page.click('[data-ava] [data-run]');
    await page.waitForSelector('text=合格 1/1', { timeout: 30000 });
    await page.click('[data-ava] [data-prod]');
    await page.waitForSelector('.modal');
    assert(await page.$eval('.modal [data-act="ok"]', b => b.disabled), '本番公開は名前の入力が必要');
    await page.fill('.modal input', '会員AVA');
    await page.click('.modal [data-act="ok"]');
    await page.waitForSelector('text=本番公開済み', { timeout: 30000 });
    assert(v1.status === 'ProductionReady', '本番公開');

    // 変更 → v2: このアプリが作ったフローとAVAには新しい版、他人のものは触らない
    store.flows.push({ id: 'flow-other', name: '会員_用件ボット_他', type: 'BOT', description: '', publishedVersion: { id: '1' } });
    specVersion = 2;
    await page.click('.step[data-phase="hearing"]');
    await page.fill('#chatInput', '挨拶を変えて、AVAに一言追加したい');
    await page.click('#sendBtn');
    await page.waitForFunction(() => document.querySelectorAll('.msg-assistant').length === 2);
    await page.click('#toSpecBtn');
    await page.waitForSelector('.diff');
    await page.click('#commitBtn');
    await page.waitForSelector('text=設計書 v2');
    await page.click('.step[data-phase="build"]');
    await page.click('#planBtn');
    await page.waitForSelector('text=新しい版を反映します', { timeout: 30000 });
    const flowsBefore = store.flows.length;
    await page.click('#runBtn');
    await page.waitForSelector('.modal');
    assert((await page.textContent('.modal')).includes('[新しい版]'), '確認ダイアログに新しい版を明示');
    await page.click('.modal [data-act="ok"]');
    await page.waitForSelector('text=新しい版を反映', { timeout: 90000 });
    await page.waitForFunction(() => document.querySelector('#resultMeta')?.textContent.includes('v2'), null, { timeout: 90000 });
    assert(store.flows.length === flowsBefore, 'フローを増やさず版を上げる');
    assert(store.flows.find(f => f.name === '会員_着信_営業時間内').yaml.includes('(新)'), '着信フローに変更が入る');
    assert(store.versions[ava.id].length === 2 && store.versions[ava.id][1].definition.instructions.length === 2, 'AVAに新しい版');
    assert(store.virtualagents.length === 1, 'AVAを作り直さない');
    assert(!store.writes.some(w => w.includes('flow-other')), '他人のフローには触らない');

    assert(!errors.length, `コンソールエラー: ${errors.join(' | ')}`);
  } finally {
    await close();
  }
};
