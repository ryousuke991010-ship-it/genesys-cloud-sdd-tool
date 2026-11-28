/* 起動・画面の切り替え・ヘッダーの接続状態 */
import { handleOAuthCallback, restoreSession, onAuthChange, getAuthState, logout } from './js/core/genesysAuth.js';
import { hasPendingWrites } from './js/core/gcApi.js';
import { isBusy, setBusy, navigate, hooks } from './js/core/appState.js';
import { listProjects, loadSettings } from './js/core/store.js';
import { configuredProviders, PROVIDERS } from './js/core/ai.js';
import { escapeHtml, confirmDialog, toast } from './js/core/ui.js';
import { initSync, onSyncChange, getSyncState, resumeFolderAccess, flush, MODES } from './js/core/sync.js';
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

/* 画面の切り替えは1つずつ順番に行う(起動中にURLが変わっても、遅く終わった描画が新しい画面を上書きしない) */
let routeQueue = Promise.resolve();
function enqueueRoute() { routeQueue = routeQueue.then(route, route); return routeQueue; }

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

function refreshSyncPill(st = getSyncState()) {
  const pill = document.getElementById('syncPill');
  const mark = { ok: ' ✓', pending: ' …', saving: ' …', error: ' ⚠', needsPermission: ' ⚠' }[st.status] || '';
  pill.textContent = `保存: ${MODES[st.mode].label}${st.mode === 'browser' ? '' : mark}`;
  pill.title = st.message || 'データの保存先(設定画面で変更できます)';
  pill.classList.toggle('pill-ok', st.status === 'ok');
  pill.classList.toggle('pill-warn', st.status === 'error' || st.status === 'needsPermission');
}

async function onSyncPill() {
  const st = getSyncState();
  try {
    if (st.status === 'needsPermission') {
      const r = await resumeFolderAccess();
      toast(r.pulled ? `保存先から${r.pulled}件を取り込みました` : '保存先へのアクセスを再開しました', 'success');
      await refreshNav();
      if (location.hash === '' || location.hash === '#/') enqueueRoute();
    } else if (st.status === 'error' || st.status === 'pending') {
      await flush();
      const now = getSyncState();
      toast(now.status === 'ok' ? '保存先に保存しました' : now.message, now.status === 'ok' ? 'success' : 'error');
    } else {
      navigate('#/settings');
    }
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function start() {
  hooks.refreshNav = refreshNav;
  onSyncChange(refreshSyncPill);
  refreshSyncPill();
  document.getElementById('syncPill').addEventListener('click', onSyncPill);
  await initSync();
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
  window.addEventListener('hashchange', enqueueRoute);
  enqueueRoute();
}

if (!handleOAuthCallback()) start();
