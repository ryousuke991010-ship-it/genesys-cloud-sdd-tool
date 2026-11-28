/* プロジェクトの保存 — ブラウザ内のIndexedDB(手元の作業コピー)
 *
 * このアプリはサーバーを持たない。業務プロジェクト(会話・設計書・構築ログ・テスト結果)は
 * まずブラウザの中に保存し、利用者が選んだ保存先(自分のPCのフォルダ / 自分のGitHubリポジトリ)
 * があれば sync.js がそこへも書き出す。運営側には何も送らない。
 */

const DB_NAME = 'gc_sdd_v1';
const STORE = 'projects';
const META = 'meta';
let dbPromise = null;

/* 保存・削除のたびに呼ぶ(sync.js が保存先への書き出しを予約する) */
let changeHook = null;
export function setChangeHook(fn) { changeHook = fn; }

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

function tx(mode, fn, storeName = STORE) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const s = t.objectStore(storeName);
    let result;
    Promise.resolve(fn(s)).then(r => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
  }));
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function listProjects() {
  const all = await tx('readonly', s => reqToPromise(s.getAll()));
  return (all || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function getProject(id) {
  return tx('readonly', s => reqToPromise(s.get(id)));
}

export async function saveProject(project) {
  project.updatedAt = Date.now();
  await tx('readwrite', s => reqToPromise(s.put(project)));
  changeHook?.('save', project);
  return project;
}

/** 保存先から取り込んだものを、更新日時を変えずにそのまま置く(保存先へは書き戻さない) */
export async function putProjectRaw(project) {
  await tx('readwrite', s => reqToPromise(s.put(project)));
}

export async function deleteProject(id) {
  await tx('readwrite', s => reqToPromise(s.delete(id)));
  changeHook?.('delete', { id });
}

/* フォルダの参照(FileSystemDirectoryHandle)など、localStorageに置けない値の置き場 */
export const getMeta = key => tx('readonly', s => reqToPromise(s.get(key)), META);
export const setMeta = (key, value) => tx('readwrite', s => reqToPromise(s.put(value, key)), META);

export async function exportAll() {
  return { format: 'gc-sdd-export', version: 1, exportedAt: new Date().toISOString(), projects: await listProjects() };
}

export async function importAll(data) {
  if (data?.format !== 'gc-sdd-export' || !Array.isArray(data.projects)) {
    throw new Error('このアプリで書き出したファイルではありません。');
  }
  for (const p of data.projects) {
    if (p && typeof p.id === 'string' && typeof p.name === 'string') {
      await tx('readwrite', s => reqToPromise(s.put(p)));
      changeHook?.('save', p);
    }
  }
  return data.projects.length;
}

/* ---- 設定(APIキー・接続先) ----
 * APIキーはこの端末のlocalStorageにだけ置く。共有PCでは使い終わったら「削除」を押す運用にする。 */
const SETTINGS_KEY = 'gc_sdd_settings_v1';

export function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch { /* 保存できない環境では今回の画面の間だけ有効 */ }
}
