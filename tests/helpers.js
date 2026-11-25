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
  const browser = await chromium.launch();
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

function assert(cond, msg) { if (!cond) throw new Error(`assert: ${msg}`); }

module.exports = { launch, seedConnected, assert };
