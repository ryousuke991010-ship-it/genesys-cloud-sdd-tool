/* プロジェクトの保存先 — ブラウザ内のIndexedDBだけ
 *
 * このアプリはサーバーを持たない。業務プロジェクト(会話・設計書・構築ログ・テスト結果)は
 * 利用者のブラウザの中にだけ保存し、どこにも送らない(AIへの送信は利用者が会話した内容だけ)。
 * 端末を替える・バックアップする時は「書き出し/読み込み」(JSON)で持ち運ぶ。
 */

const DB_NAME = 'gc_sdd_v1';
const STORE = 'projects';
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

function tx(mode, fn) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const s = t.objectStore(STORE);
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
  return project;
}

export async function deleteProject(id) {
  await tx('readwrite', s => reqToPromise(s.delete(id)));
}

export async function exportAll() {
  return { format: 'gc-sdd-export', version: 1, exportedAt: new Date().toISOString(), projects: await listProjects() };
}

export async function importAll(data) {
  if (data?.format !== 'gc-sdd-export' || !Array.isArray(data.projects)) {
    throw new Error('このアプリで書き出したファイルではありません。');
  }
  for (const p of data.projects) {
    if (p && typeof p.id === 'string' && typeof p.name === 'string') await tx('readwrite', s => reqToPromise(s.put(p)));
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
