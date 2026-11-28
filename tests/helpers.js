/* テスト共通: 静的サーバーを立て、Genesys Cloud・各AIのAPIをpage.route()でモックする */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function waitPort(port, ms = 10000) {
  const end = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error', () => { sock.destroy(); Date.now() > end ? reject(new Error('server did not start')) : setTimeout(tryOnce, 100); });
    };
    tryOnce();
  });
}

async function launch() {
  const port = await freePort();
  const server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', ROOT], { stdio: 'ignore' });
  await waitPort(port);
  // 本物のChromium(新ヘッドレス)で動かす。軽量版(headless shell)はフォルダ保存のテストで落ちるため
  const browser = await chromium.launch({ channel: 'chromium' });
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('dialog', d => d.accept('手動シナリオ'));
  const close = async () => { await browser.close(); server.kill(); };
  return { page, url: `http://127.0.0.1:${port}/`, errors, close };
}

/** 接続済み状態(AIキー+Genesysトークン)をlocalStorageに入れておく */
async function seedConnected(page, url, { gc = true } = {}) {
  await page.goto(url);
  await page.evaluate(({ gc }) => {
    localStorage.setItem('gc_sdd_settings_v1', JSON.stringify({
      ai: { anthropic: { apiKey: 'sk-ant-test', model: 'claude-opus-5-5' } },
      genesys: { region: 'mypurecloud.jp', clientId: '00000000-0000-4000-8000-000000000000' }
    }));
    if (gc) localStorage.setItem('gc_sdd_token_v1', JSON.stringify({ token: 'tok', region: 'mypurecloud.jp', clientId: 'x', expiresAt: Date.now() + 3600e3 }));
  }, { gc });
  await page.reload();
}

/**
 * Genesys Cloud Platform API のメモリ上のモック。store を直接見て、書き込まれた内容を検証できる。
 * フローは POST /api/v2/flows/jobs → 署名付きURLへPUT → ジョブ照会 の流れを再現する。
 */
async function mockGenesys(page) {
  const store = {
    skills: [], wrapupcodes: [], queues: [], schedules: [], schedulegroups: [], ivrs: [], datatables: [], flows: [], virtualagents: [],
    dids: [], users: [], userSkills: {}, userQueues: {}, rows: {}, versions: {}, uploads: [], writes: [], sessions: []
  };
  let seq = 0;
  const nid = p => `${p}-${++seq}`;
  const COLL = {
    'routing/skills': 'skills', 'routing/wrapupcodes': 'wrapupcodes', 'routing/queues': 'queues',
    'architect/schedules': 'schedules', 'architect/schedulegroups': 'schedulegroups', 'architect/ivrs': 'ivrs',
    'flows/datatables': 'datatables', flows: 'flows', 'agentic/virtualagents': 'virtualagents'
  };
  const jobs = {};
  await page.route('https://upload.test/**', async route => {
    const id = new URL(route.request().url()).pathname.slice(1);
    store.uploads.push({ id, yaml: route.request().postData() });
    jobs[id].yaml = route.request().postData();
    await route.fulfill({ status: 200, body: '' });
  });
  await page.route('https://api.mypurecloud.jp/**', async route => {
    const req = route.request();
    const u = new URL(req.url());
    const path = u.pathname.replace('/api/v2/', '');
    const method = req.method();
    const body = req.postData() ? JSON.parse(req.postData()) : undefined;
    const json = (j, status = 200) => route.fulfill({ status, json: j });
    if (method !== 'GET' && !path.startsWith('users/search') && !u.searchParams.get('validateOnly')) store.writes.push(`${method} ${path}`);

    // --- Architect ジョブ(YAMLの取り込み) ---
    if (path === 'flows/jobs' && method === 'POST') { const id = nid('job'); jobs[id] = {}; return json({ id, presignedUrl: `https://upload.test/${id}`, headers: { 'Content-Type': 'application/octet-stream' } }); }
    let m = path.match(/^flows\/jobs\/([^/]+)$/);
    if (m) {
      const job = jobs[m[1]];
      if (!job?.yaml) return json({ id: m[1], status: 'Started' });
      const type = job.yaml.startsWith('botFlow:') ? 'BOT' : 'INBOUNDCALL';
      const name = JSON.parse(job.yaml.match(/\n  name: (".*")/)[1]);
      const description = JSON.parse((job.yaml.match(/\n  description: (".*")/) || [, '""'])[1]);
      let f = store.flows.find(x => x.name === name && x.type === type);
      if (f) { f.publishedVersion = { id: String(Number(f.publishedVersion.id) + 1) }; f.yaml = job.yaml; }
      else { f = { id: nid('flow'), name, type, description, publishedVersion: { id: '1' }, yaml: job.yaml }; store.flows.push(f); }
      return json({ id: m[1], status: 'Success', command: 'Publish', flow: { id: f.id } });
    }
    // --- ユーザー ---
    if (path === 'users/search') return json({ results: store.users.filter(x => x.email === body.query[0].value), total: 1 });
    m = path.match(/^users\/([^/]+)\/routingskills$/);
    if (m) {
      const list = store.userSkills[m[1]] = store.userSkills[m[1]] || [];
      if (method === 'POST') { list.push({ id: body.id, proficiency: body.proficiency }); return json(body); }
      return json({ entities: list, pageCount: 1 });
    }
    m = path.match(/^users\/([^/]+)\/queues$/);
    if (m) return json({ entities: u.searchParams.get('joined') === 'false' ? [] : (store.userQueues[m[1]] || []).map(id => ({ id, joined: true })), pageCount: 1 });
    m = path.match(/^routing\/queues\/([^/]+)\/members$/);
    if (m && method === 'POST') { body.forEach(x => { (store.userQueues[x.id] = store.userQueues[x.id] || []).push(m[1]); }); return json({}); }
    if (path === 'telephony/providers/edges/dids') return json({ entities: store.dids.filter(d => d.phoneNumber === u.searchParams.get('phoneNumber')), pageCount: 1 });
    // --- データテーブルの行 ---
    m = path.match(/^flows\/datatables\/([^/]+)\/rows$/);
    if (m) {
      const rows = store.rows[m[1]] = store.rows[m[1]] || [];
      if (method === 'POST') { rows.push(body); return json(body); }
      return json({ entities: rows, pageCount: 1 });
    }
    // --- AVA ---
    m = path.match(/^agentic\/virtualagents\/([^/]+)\/versions(?:\/([^/]+))?(?:\/jobs(?:\/([^/]+))?)?$/);
    if (m) {
      const [, aid, ver, jobId] = m;
      const vs = store.versions[aid] = store.versions[aid] || [];
      if (!ver && method === 'POST') {
        if (!body.definition?.role || !Array.isArray(body.definition.instructions)) return json({ message: 'definition.role is required', details: [{ fieldName: 'definition.role' }] }, 400);
        if (u.searchParams.get('validateOnly') === 'true') return json({});
        const v = { version: String(vs.length + 1), definition: body.definition, status: 'Draft' };
        vs.push(v);
        store.virtualagents.find(a => a.id === aid).latestSavedVersion = { version: v.version };
        return json(v);
      }
      const v = vs.find(x => x.version === ver);
      if (u.pathname.endsWith('/jobs') && method === 'POST') { v.status = body.virtualAgentVersion.status; return json({ id: nid('pjob'), status: 'InProgress' }); }
      if (jobId) return json({ id: jobId, status: 'Succeeded' });
      return json({ ...v, virtualAgent: { id: aid } });
    }
    m = path.match(/^agentic\/virtualagents\/([^/]+)\/sessions(?:\/([^/]+)\/turns)?$/);
    if (m) {
      if (!m[2]) { const id = nid('ses'); store.sessions.push({ id, body }); return json({ id, version: body.version }); }
      const text = body.inputEvent.type === 'NoOp' ? 'こんにちは、会員サポートAIです。' : `「${body.inputEvent.alternatives[0].transcript.text}」について承知しました。`;
      return json({ id: nid('turn'), prompts: { text: { segments: [{ type: 'Text', text }] } }, nextAction: { type: 'WaitForInput' }, events: { toolCalls: [] } });
    }
    // --- 汎用コレクション ---
    const key = Object.keys(COLL).sort((a, b) => b.length - a.length).find(k => path === k || path.startsWith(`${k}/`));
    if (!key) return json({ message: 'not mocked ' + u.pathname }, 404);
    const coll = store[COLL[key]];
    const id = path.slice(key.length + 1) || null;
    if (method === 'GET' && !id) {
      const name = u.searchParams.get('name');
      let list = coll.filter(e => !name || e.name.toLowerCase().startsWith(name.toLowerCase()));
      if (u.searchParams.get('type')) list = list.filter(e => e.type === u.searchParams.get('type'));
      if (u.searchParams.get('dnis')) list = list.filter(e => (e.dnis || []).includes(u.searchParams.get('dnis')));
      return json({ entities: list, pageCount: 1 });
    }
    const e = coll.find(x => x.id === id);
    if (method === 'GET') return e ? json(e) : json({ message: 'nf' }, 404);
    if (method === 'POST') { const ne = { ...body, id: nid(COLL[key]) }; coll.push(ne); return json(ne); }
    if (method === 'PUT') { Object.assign(e, body, { version: (e.version || 1) + 1 }); return json(e); }
    return json({}, 405);
  });
  return store;
}

function assert(cond, msg) { if (!cond) throw new Error(`assert: ${msg}`); }

module.exports = { launch, seedConnected, assert, mockGenesys };
