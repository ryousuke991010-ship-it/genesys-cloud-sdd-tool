/* テスト共通: 静的サーバーを立て、Genesys Cloud・各AIのAPIをpage.route()でモックする */
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

/** 静的ファイルを配るだけのサーバー(依存なし。ROOTの外は返さない) */
function startServer() {
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(data);
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function launch() {
  const server = await startServer();
  const { port } = server.address();
  const browser = await chromium.launch();
  browser.on('disconnected', () => console.error('  [browser disconnected]'));
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('crash', () => { console.error(`  [page crashed] ${page.url()}`); });
  page.on('dialog', d => d.accept('手動シナリオ'));
  const close = async () => { await browser.close(); server.close(); };
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
