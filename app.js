/* 起動・画面の切り替え・ヘッダーの接続状態 */
import { handleOAuthCallback, restoreSession, onAuthChange, getAuthState, logout } from './js/core/genesysAuth.js';
import { hasPendingWrites } from './js/core/gcApi.js';
import { isBusy, setBusy, navigate, hooks } from './js/core/appState.js';
import { listProjects, loadSettings } from './js/core/store.js';
import { configuredProviders, PROVIDERS } from './js/core/ai.js';
import { escapeHtml, confirmDialog } from './js/core/ui.js';
import { renderHome, openNewProjectDialog } from './js/views/home.js';
import { renderProject } from './js/views/project.js';
import { renderSettings, openConnectDialog } from './js/views/settings.js';

let cleanup = null;

async function canLeave() {
  if (!isBusy() && !hasPendingWrites()) return true;
  return confirmDialog({
    title: '処理の途中です',
    bodyHtml: '<p>構築やAIの処理が終わる前に画面を移ると、結果の記録が残らない場合があります。それでも移動しますか?</p>',
    okLabel: '移動する', danger: true
  });
}

let lastHash = location.hash;
async function route() {
  if (location.hash !== lastHash && !(await canLeave())) {
    history.replaceState(null, '', lastHash || '#/');
    return;
  }
  lastHash = location.hash;
  if (typeof cleanup === 'function') cleanup();
  cleanup = null;
  setBusy(false);
  const content = document.getElementById('content');
  const [, page, id] = (location.hash || '#/').split('/');
  const title = document.getElementById('pageTitle');
  if (page === 'project' && id) {
    cleanup = await renderProject(content, decodeURIComponent(id), { setTitle: t => setTitle(title, t) });
  } else if (page === 'settings') {
    setTitle(title, '設定');
    cleanup = renderSettings(content, { onChange: refreshChrome });
  } else {
    setTitle(title, '');
    cleanup = await renderHome(content);
  }
  await refreshNav();
  content.focus({ preventScroll: true });
}

function setTitle(el, text) {
  el.innerHTML = `<a href="#/" class="crumb-home">ホーム</a>${text ? ` <span class="crumb-sep">›</span> <span>${escapeHtml(text)}</span>` : ''}`;
}

async function refreshNav() {
  const nav = document.getElementById('nav');
  const projects = await listProjects();
  const [, page, id] = (location.hash || '#/').split('/');
  nav.innerHTML = projects.length
    ? projects.map(p => `<a class="nav-item${page === 'project' && decodeURIComponent(id || '') === p.id ? ' active' : ''}" href="#/project/${encodeURIComponent(p.id)}">
        <span class="nav-dot phase-${escapeHtml(p.phase || 'hearing')}"></span><span class="nav-label">${escapeHtml(p.name)}</span></a>`).join('')
    : '<p class="nav-empty">まだプロジェクトがありません</p>';
}

function refreshChrome() {
  const settings = loadSettings();
  const ais = configuredProviders(settings);
  const aiPill = document.getElementById('aiPill');
  aiPill.textContent = ais.length ? `AI: ${ais.map(a => PROVIDERS[a].label.split(' ')[0]).join(' / ')}` : 'AI: 未設定';
  aiPill.classList.toggle('pill-ok', ais.length > 0);

  const st = getAuthState();
  const gcPill = document.getElementById('gcPill');
  const btn = document.getElementById('gcConnectBtn');
  gcPill.textContent = st.connected ? `Genesys: 接続中 (${st.region})` : 'Genesys: 未接続';
  gcPill.classList.toggle('pill-ok', st.connected);
  btn.textContent = st.connected ? '切断' : 'Genesys Cloudに接続';
}

function start() {
  hooks.refreshNav = refreshNav;
  restoreSession();
  onAuthChange(refreshChrome);
  refreshChrome();
  document.getElementById('gcConnectBtn').addEventListener('click', async () => {
    if (getAuthState().connected) {
      if (await confirmDialog({ title: 'Genesys Cloudから切断', bodyHtml: '<p>この端末に保存した接続情報(アクセストークン)を削除します。</p>', okLabel: '切断する' })) logout();
    } else {
      openConnectDialog();
    }
  });
  document.getElementById('newProjectBtn').addEventListener('click', () => openNewProjectDialog());
  document.getElementById('settingsBtn').addEventListener('click', () => navigate('#/settings'));
  window.addEventListener('hashchange', route);
  route();
}

if (!handleOAuthCallback()) start();
