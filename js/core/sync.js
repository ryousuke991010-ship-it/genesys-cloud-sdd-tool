/* データの保存先 — 利用者が選ぶ(運営側には何も保存しない)
 *
 *   browser : このブラウザの中だけ(IndexedDB)。消されにくいよう永続化をブラウザに申請する
 *   folder  : 自分のPCのフォルダ(File System Access API。Chrome/Edge)。OneDrive等の同期フォルダを選べばクラウドにも残る
 *   github  : 自分のGitHubリポジトリ(プロジェクト1つ=JSONファイル1つ。保存ごとにコミットされ履歴が残る)
 *
 * どの方式でもブラウザ内のIndexedDBが手元の作業コピーで、保存先へは少し待ってからまとめて書き出す。
 * 起動時・切り替え時は保存先を読み、保存先の方が新しいプロジェクトだけを手元に取り込む(更新日時で判断)。
 * GitHubのトークンはこの端末にだけ置き、api.github.com にだけ送る。
 */
import { loadSettings, saveSettings, listProjects, getProject, putProjectRaw, setChangeHook, getMeta, setMeta } from './store.js';

export const MODES = {
  browser: { label: 'このブラウザだけ', icon: '🌐' },
  folder: { label: 'PCのフォルダ', icon: '📁' },
  github: { label: 'GitHubリポジトリ', icon: '🐙' }
};

const FILE_FORMAT = 'gc-sdd-project';
const DELAY = { folder: 1500, github: 8000 };
const GH = 'https://api.github.com';

let state = { status: 'idle', message: '', at: null };
const listeners = new Set();
export const onSyncChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };
export const getSyncState = () => ({ ...state, mode: currentMode() });
function setState(patch) {
  state = { ...state, ...patch };
  listeners.forEach(fn => { try { fn(getSyncState()); } catch { /* noop */ } });
}

export function storageSettings() {
  const s = loadSettings().storage || {};
  return { mode: MODES[s.mode] ? s.mode : 'browser', github: { branch: 'main', dir: 'sdd-projects', ...(s.github || {}) } };
}
const currentMode = () => storageSettings().mode;

export function saveStorageSettings(storage) {
  const cur = loadSettings();
  cur.storage = storage;
  saveSettings(cur);
}

export const folderSupported = () => typeof window.showDirectoryPicker === 'function';

/* ---------- 永続化(ブラウザが容量不足の時に勝手に消さないよう申請) ---------- */
export async function requestPersist() {
  try {
    if (!navigator.storage?.persist) return null;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return null;
  }
}

const fileText = project => JSON.stringify({ format: FILE_FORMAT, version: 1, savedAt: new Date().toISOString(), project }, null, 2);
const fileName = id => `${id.replace(/[^A-Za-z0-9_-]/g, '_')}.json`;
function parseFile(text) {
  const d = JSON.parse(text);
  const p = d?.format === FILE_FORMAT ? d.project : null;
  return p && typeof p.id === 'string' && typeof p.name === 'string' ? p : null;
}

/* ---------- PCのフォルダ ---------- */
let folderHandle = null; // 一度選んだ・読み込んだフォルダはメモリに持ち、毎回データベースから読み直さない
const folder = {
  async handle() {
    if (!folderHandle) folderHandle = (await getMeta('folderHandle')) || null;
    return folderHandle;
  },
  async permission(h, ask) {
    if (!h) return 'none';
    if (typeof h.queryPermission !== 'function') return 'granted';
    const opts = { mode: 'readwrite' };
    let p = await h.queryPermission(opts);
    if (p !== 'granted' && ask) p = await h.requestPermission(opts);
    return p;
  },
  async pick() {
    const h = await window.showDirectoryPicker({ id: 'gc-sdd', mode: 'readwrite' });
    await setMeta('folderHandle', h);
    folderHandle = h;
    return h;
  },
  async write(project) {
    const h = await folder.ready();
    const fh = await h.getFileHandle(fileName(project.id), { create: true });
    const w = await fh.createWritable();
    await w.write(fileText(project));
    await w.close();
  },
  async remove(id) {
    const h = await folder.ready();
    try { await h.removeEntry(fileName(id)); } catch (e) { if (e.name !== 'NotFoundError') throw e; }
  },
  async readAll() {
    const h = await folder.ready();
    const out = [];
    for await (const [name, entry] of h.entries()) {
      if (entry.kind !== 'file' || !name.endsWith('.json')) continue;
      try {
        const p = parseFile(await (await entry.getFile()).text());
        if (p) out.push(p);
      } catch { /* このアプリのファイルでないものは無視 */ }
    }
    return out;
  },
  async ready() {
    const h = await folder.handle();
    if (!h) throw new Error('保存先のフォルダが選ばれていません。設定画面でフォルダを選んでください。');
    if (await folder.permission(h, false) !== 'granted') {
      const e = new Error('フォルダへのアクセス許可が切れています。「保存先へのアクセスを再開」を押してください。');
      e.needsPermission = true;
      throw e;
    }
    return h;
  }
};

/* ---------- GitHub ---------- */
function b64encode(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const github = {
  cfg() {
    const g = storageSettings().github;
    if (!g.owner || !g.repo || !g.token) throw new Error('GitHubの保存先(オーナー・リポジトリ・トークン)が未設定です。');
    return g;
  },
  async call(method, path, { body, raw } = {}, g = github.cfg()) {
    let res;
    try {
      res = await fetch(`${GH}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${g.token}`,
          Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined
      });
    } catch (e) {
      throw new Error(`GitHubに接続できませんでした: ${e.message}`);
    }
    if (res.status === 404) return null;
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const hint = res.status === 401 ? '(トークンが無効か期限切れです)'
        : res.status === 403 ? '(トークンにこのリポジトリの Contents: Read and write 権限があるか確認してください)'
          : res.status === 409 || res.status === 422 ? '(別の端末で同時に保存された可能性があります。もう一度保存してください)' : '';
      const err = new Error(`GitHub: ${data.message || `HTTP ${res.status}`}${hint}`);
      err.status = res.status;
      throw err;
    }
    if (res.status === 204) return null;
    return raw ? res.text() : res.json();
  },
  path(g, id) {
    const dir = (g.dir || '').replace(/^\/+|\/+$/g, '');
    return `/repos/${encodeURIComponent(g.owner)}/${encodeURIComponent(g.repo)}/contents/${dir ? `${dir.split('/').map(encodeURIComponent).join('/')}/` : ''}${id ? fileName(id) : ''}`;
  },
  async sha(g, id) {
    const meta = await github.call('GET', `${github.path(g, id)}?ref=${encodeURIComponent(g.branch)}`, {}, g);
    return meta?.sha || undefined;
  },
  async write(project) {
    const g = github.cfg();
    const body = sha => ({ message: `SDD: 「${project.name}」を保存`, content: b64encode(fileText(project)), branch: g.branch, ...(sha ? { sha } : {}) });
    try {
      await github.call('PUT', github.path(g, project.id), { body: body(await github.sha(g, project.id)) }, g);
    } catch (e) {
      if (e.status !== 409 && e.status !== 422) throw e;
      await github.call('PUT', github.path(g, project.id), { body: body(await github.sha(g, project.id)) }, g);
    }
  },
  async remove(id) {
    const g = github.cfg();
    const sha = await github.sha(g, id);
    if (sha) await github.call('DELETE', github.path(g, id), { body: { message: `SDD: プロジェクト ${id} を削除`, sha, branch: g.branch } }, g);
  },
  async readAll() {
    const g = github.cfg();
    const list = await github.call('GET', `${github.path(g, null).replace(/\/$/, '')}?ref=${encodeURIComponent(g.branch)}`, {}, g);
    if (!list) return [];
    if (!Array.isArray(list)) throw new Error('GitHubの保存先がフォルダではありません。「フォルダ」の設定を確認してください。');
    const out = [];
    for (const f of list.filter(x => x.type === 'file' && x.name.endsWith('.json'))) {
      try {
        const p = parseFile(await github.call('GET', `${github.path(g, null)}${encodeURIComponent(f.name)}?ref=${encodeURIComponent(g.branch)}`, { raw: true }, g));
        if (p) out.push(p);
      } catch { /* このアプリのファイルでないものは無視 */ }
    }
    return out;
  },
  /** 設定画面の「接続を確認」。書き込み権限まで確かめる */
  async check(g) {
    const repo = await github.call('GET', `/repos/${encodeURIComponent(g.owner)}/${encodeURIComponent(g.repo)}`, {}, g);
    if (!repo) throw new Error('リポジトリが見つかりません(名前か、トークンの対象リポジトリを確認してください)。');
    if (repo.permissions && !repo.permissions.push) throw new Error('このトークンでは書き込めません(Contents: Read and write が必要です)。');
    const branch = await github.call('GET', `/repos/${encodeURIComponent(g.owner)}/${encodeURIComponent(g.repo)}/branches/${encodeURIComponent(g.branch)}`, {}, g);
    if (!branch) throw new Error(`ブランチ「${g.branch}」がありません。`);
    return { private: repo.private, fullName: repo.full_name };
  }
};

const backend = mode => (mode === 'folder' ? folder : mode === 'github' ? github : null);

/* ---------- 書き出しの予約(保存のたびに呼ばれる) ---------- */
const pending = new Map();
let timer = null;

function schedule(kind, project) {
  const mode = currentMode();
  if (!backend(mode)) return;
  pending.set(project.id, kind);
  setState({ status: 'pending', message: '保存先への書き出しを待っています' });
  clearTimeout(timer);
  timer = setTimeout(flush, DELAY[mode]);
}

export const hasUnsynced = () => pending.size > 0;

/** 予約されている書き出しを今すぐ行う */
export async function flush() {
  clearTimeout(timer);
  const mode = currentMode();
  const b = backend(mode);
  if (!b || !pending.size) return;
  const jobs = [...pending.entries()];
  pending.clear();
  setState({ status: 'saving', message: '保存先に書き出し中…' });
  try {
    for (const [id, kind] of jobs) {
      if (kind === 'delete') await b.remove(id);
      else {
        const p = await getProject(id);
        if (p) await b.write(p);
      }
    }
    setState({ status: 'ok', message: '保存先に保存済み', at: Date.now() });
  } catch (e) {
    jobs.forEach(([id, kind]) => { if (!pending.has(id)) pending.set(id, kind); });
    setState({ status: e.needsPermission ? 'needsPermission' : 'error', message: e.message });
  }
}

/** 保存先を読み、保存先の方が新しいものを手元に取り込む。戻り値: { pulled, remote } */
export async function pull() {
  const b = backend(currentMode());
  if (!b) return { pulled: 0, remote: 0 };
  setState({ status: 'saving', message: '保存先を読み込み中…' });
  try {
    const remote = await b.readAll();
    let pulled = 0;
    for (const p of remote) {
      const local = await getProject(p.id);
      if (!local || (p.updatedAt || 0) > (local.updatedAt || 0)) { await putProjectRaw(p); pulled++; }
    }
    setState({ status: pending.size ? 'pending' : 'ok', message: pending.size ? '保存先への書き出しを待っています' : '保存先と同期済み', at: Date.now() });
    return { pulled, remote: remote.length };
  } catch (e) {
    setState({ status: e.needsPermission ? 'needsPermission' : 'error', message: e.message });
    throw e;
  }
}

/** 手元の全プロジェクトを保存先へ書き出す(保存先を切り替えた直後に使う) */
export async function pushAll() {
  (await listProjects()).forEach(p => pending.set(p.id, 'save'));
  await flush();
  if (state.status === 'error' || state.status === 'needsPermission') throw new Error(state.message);
}

/** 保存先を切り替える: 保存先を読み(新しい方を取り込み)、手元の全件を書き出す */
export async function switchMode(storage) {
  saveStorageSettings(storage);
  pending.clear();
  if (!backend(storage.mode)) { setState({ status: 'idle', message: '', at: null }); return { pulled: 0, remote: 0 }; }
  const r = await pull();
  await pushAll();
  return r;
}

export const pickFolder = () => folder.pick();
export async function currentFolderName() {
  const h = await folder.handle();
  return h ? h.name || '(名前のないフォルダ)' : '';
}
export const checkGithub = g => github.check(g);

/** フォルダの許可が切れた時(再読み込み後など)。ボタン押下の中で呼ぶ必要がある */
export async function resumeFolderAccess() {
  const h = await folder.handle();
  if (await folder.permission(h, true) !== 'granted') throw new Error('フォルダへのアクセスが許可されませんでした。');
  const r = await pull();
  await flush();
  return r;
}

/** 起動時: 永続化を申請し、保存先があれば読み込む(許可が要るフォルダは、利用者の操作を待つ) */
export async function initSync() {
  setChangeHook(schedule);
  requestPersist();
  window.addEventListener('beforeunload', e => {
    if (pending.size) { flush(); e.preventDefault(); e.returnValue = ''; }
  });
  if (!backend(currentMode())) return null;
  try {
    return await pull();
  } catch {
    return null;
  }
}
