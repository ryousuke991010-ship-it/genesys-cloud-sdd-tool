/* Genesys Cloud への接続 (OAuth Authorization Code + PKCE、ポップアップ方式)
 *
 * ログインするのはGenesys Cloud自身の画面。このアプリはパスワードを一切扱わず、
 * 受け取るのは利用者本人の権限のアクセストークンだけ(端末のlocalStorageに期限つきで保存)。
 * 書き込める範囲は、その利用者のGenesys Cloud上のロールで決まる。
 *
 * Genesysのログイン画面はiframe内での表示を拒否するため、ログインだけ別ウィンドウで行い、
 * 認可コードをpostMessageで本体に戻す(genesys-cloud-toolと同じ方式)。
 */

export const REGIONS = [
  { id: 'mypurecloud.jp', label: 'アジア太平洋(東京) mypurecloud.jp' },
  { id: 'mypurecloud.com', label: '米国東部 mypurecloud.com' },
  { id: 'usw2.pure.cloud', label: '米国西部 usw2.pure.cloud' },
  { id: 'mypurecloud.ie', label: 'EU(ダブリン) mypurecloud.ie' },
  { id: 'mypurecloud.de', label: 'EU(フランクフルト) mypurecloud.de' },
  { id: 'euw2.pure.cloud', label: 'EU(ロンドン) euw2.pure.cloud' },
  { id: 'mypurecloud.com.au', label: 'アジア太平洋(シドニー) mypurecloud.com.au' },
  { id: 'apne2.pure.cloud', label: 'アジア太平洋(ソウル) apne2.pure.cloud' },
  { id: 'apne3.pure.cloud', label: 'アジア太平洋(大阪) apne3.pure.cloud' },
  { id: 'aps1.pure.cloud', label: 'アジア太平洋(ムンバイ) aps1.pure.cloud' },
  { id: 'cac1.pure.cloud', label: 'カナダ cac1.pure.cloud' },
  { id: 'sae1.pure.cloud', label: '南米(サンパウロ) sae1.pure.cloud' }
];

const TOKEN_KEY = 'gc_sdd_token_v1';
const EXPIRY_BUFFER_MS = 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let state = { token: '', region: '', clientId: '', expiresAt: 0 };
const listeners = new Set();

export function onAuthChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function notify() { listeners.forEach(fn => fn(getAuthState())); }

export function getAuthState() {
  return { connected: !!state.token, region: state.region, expiresAt: state.expiresAt };
}
export function getToken() { return state.token; }
export function apiBase() { return state.region ? `https://api.${state.region}` : ''; }
function loginBase(region) { return `https://login.${region}`; }

export function isValidClientId(id) { return UUID_RE.test(String(id || '').trim()); }

export function restoreSession() {
  try {
    const saved = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null');
    if (!saved?.token || !saved.region) return false;
    if (saved.expiresAt - EXPIRY_BUFFER_MS <= Date.now()) {
      localStorage.removeItem(TOKEN_KEY);
      return false;
    }
    state = saved;
    notify();
    return true;
  } catch {
    return false;
  }
}

export function logout() {
  state = { token: '', region: '', clientId: '', expiresAt: 0 };
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* noop */ }
  notify();
}

function redirectUri() {
  return location.href.split('#')[0].split('?')[0];
}

function randomVerifier() {
  const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = crypto.getRandomValues(new Uint8Array(64));
  return Array.from(bytes, b => c[b % c.length]).join('');
}

async function challengeOf(v) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
  return btoa(String.fromCharCode(...new Uint8Array(h))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function waitForCode(popup, expectedState) {
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (popup.closed) { cleanup(); reject(new Error('ログインがキャンセルされました。')); }
    }, 500);
    function onMessage(e) {
      if (e.origin !== location.origin || e.data?.type !== 'gc-sdd-oauth') return;
      cleanup();
      if (!e.data.code) reject(new Error('ログインがキャンセルされました。'));
      else if (e.data.state !== expectedState) reject(new Error('ログイン応答を確認できませんでした。もう一度お試しください。'));
      else resolve(e.data.code);
    }
    function cleanup() {
      clearInterval(timer);
      window.removeEventListener('message', onMessage);
      if (!popup.closed) popup.close();
    }
    window.addEventListener('message', onMessage);
  });
}

export async function login({ region, clientId }) {
  if (!REGIONS.some(r => r.id === region)) throw new Error('リージョンを選んでください。');
  if (!isValidClientId(clientId)) throw new Error('OAuthクライアントIDの形式が正しくありません(Genesys Cloudの管理画面で作成したクライアントのIDを貼り付けてください)。');

  const verifier = randomVerifier();
  const oauthState = randomVerifier().slice(0, 24);
  const url = `${loginBase(region)}/oauth/authorize?client_id=${encodeURIComponent(clientId)}`
    + `&response_type=code&redirect_uri=${encodeURIComponent(redirectUri())}`
    + `&code_challenge=${await challengeOf(verifier)}&code_challenge_method=S256`
    + `&state=${encodeURIComponent(oauthState)}`;

  const popup = window.open(url, 'gc_sdd_oauth', 'width=520,height=720');
  if (!popup) throw new Error('ポップアップがブロックされました。ブラウザでこのサイトのポップアップを許可してください。');

  const code = await waitForCode(popup, oauthState);
  const r = await fetch(`${loginBase(region)}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', client_id: clientId, code,
      redirect_uri: redirectUri(), code_verifier: verifier
    })
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error(d.error_description || 'Genesys Cloudへのログインに失敗しました。');

  state = { token: d.access_token, region, clientId, expiresAt: Date.now() + (Number(d.expires_in) || 0) * 1000 };
  try { localStorage.setItem(TOKEN_KEY, JSON.stringify(state)); } catch { /* noop */ }
  notify();
}

/** このページがOAuthのポップアップとして開かれ、認可コードを受け取った状態なら本体に渡して閉じる */
export function handleOAuthCallback() {
  const q = new URLSearchParams(location.search);
  if (!window.opener || !(q.has('code') || q.has('error'))) return false;
  window.opener.postMessage({ type: 'gc-sdd-oauth', code: q.get('code'), state: q.get('state') }, location.origin);
  window.close();
  return true;
}
