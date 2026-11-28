/* Genesys Cloud Platform API の共通ラッパー
 * タイムアウト・429リトライ・GETの一時障害リトライ・次の一手を案内するエラー文言を持つ。
 * API呼び出しは必ずここを経由する。
 */
import { getToken, apiBase, logout } from './genesysAuth.js';

const TIMEOUT_MS = 30 * 1000;
const MAX_429 = 3;
const MAX_5XX = 2;

export class GcApiError extends Error {
  constructor(status, body, method) {
    super(messageFor(status, body, method));
    this.status = status;
    this.body = body;
  }
}

function messageFor(status, body, method) {
  const base = body?.message || `Genesys Cloud APIエラー (HTTP ${status})`;
  if (status === 403) return `${base}(権限が足りない可能性があります。ログインしたユーザーのロールと、OAuthクライアントのスコープを確認してください)`;
  if (status === 429) return `${base}(リクエストが集中しています。少し待ってからやり直してください)`;
  if (status >= 500) {
    return method === 'GET'
      ? `${base}(Genesys Cloud側の一時的な問題の可能性があります。時間をおいて再試行してください)`
      : `${base}(処理が実際には反映されている可能性があります。対象の状態を確認し、未反映の場合だけ再実行してください)`;
  }
  return base;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

let pendingWrites = 0;
export function hasPendingWrites() { return pendingWrites > 0; }

async function request(method, path, body, attempt = 0) {
  const token = getToken();
  if (!token) throw new Error('Genesys Cloudに未接続です。右上の「Genesys Cloudに接続」から接続してください。');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let res;
    try {
      res = await fetch(`${apiBase()}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
        },
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
    } catch (e) {
      if (e.name === 'AbortError') throw new Error(`Genesys Cloudの応答がありません(${TIMEOUT_MS / 1000}秒でタイムアウト)。通信状況を確認してください。`);
      throw new Error(`Genesys Cloudに接続できませんでした: ${e.message}`);
    }
    if (res.status === 429 && attempt < MAX_429) {
      const ra = Number(res.headers.get('Retry-After'));
      await sleep(Math.min(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * 2 ** attempt, 60000));
      return request(method, path, body, attempt + 1);
    }
    if (method === 'GET' && res.status >= 500 && attempt < MAX_5XX) {
      await sleep(400 * (attempt + 1));
      return request(method, path, body, attempt + 1);
    }
    if (res.status === 401) {
      logout();
      throw new Error('Genesys Cloudの接続が切れました(有効期限切れ)。もう一度接続してください。');
    }
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) throw new GcApiError(res.status, data, method);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export const gcGet = path => request('GET', path);

/** 読み取りのためのPOST(検索API・validateOnly等)。組織を変更しないので書き込み件数に数えない */
export const gcQuery = (path, body) => request('POST', path, body);

export async function gcWrite(method, path, body) {
  pendingWrites++;
  try {
    return await request(method, path, body);
  } finally {
    pendingWrites--;
  }
}

/** 名前の完全一致で1件探す。nameクエリは部分一致/前方一致のことがあるため、返った中から完全一致を選ぶ */
export async function findByName(collectionPath, name, extraQuery = '') {
  const data = await gcGet(`${collectionPath}?pageSize=100&name=${encodeURIComponent(name)}${extraQuery}`);
  if (!data || !Array.isArray(data.entities)) {
    throw new Error(`${collectionPath} の応答形式が想定と違います(権限不足またはAPI仕様変更の可能性)。`);
  }
  return data.entities.find(e => e?.name === name) || null;
}

/** 一覧のエンティティ配列を取る(配列でない応答は0件と混同させず例外にする) */
export async function gcList(path) {
  const data = await gcGet(path);
  if (!data || !Array.isArray(data.entities)) throw new Error(`${path.split('?')[0]} の応答形式が想定と違います(権限不足またはAPI仕様変更の可能性)。`);
  return data.entities;
}

/**
 * Architectジョブ(POST /api/v2/flows/jobs)が返す署名付きURLへファイルを置く。
 * 送り先はGenesysが発行したS3のURLなので、Genesysのトークンは付けない。
 */
export async function uploadToPresignedUrl(url, headers, text) {
  if (!/^https:\/\//.test(url || '')) throw new Error('アップロード先URLが受け取れませんでした。');
  pendingWrites++;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let res;
    try {
      res = await fetch(url, { method: 'PUT', headers: { ...(headers || {}) }, body: text, signal: controller.signal });
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('フロー定義のアップロードがタイムアウトしました。');
      throw new Error(`フロー定義をアップロードできませんでした: ${e.message}(ブラウザからの送信がブロックされた可能性があります)`);
    }
    if (!res.ok) throw new Error(`フロー定義のアップロードに失敗しました (HTTP ${res.status})`);
  } finally {
    clearTimeout(timer);
    pendingWrites--;
  }
}

export const sleepMs = sleep;

export async function getMe() {
  return gcGet('/api/v2/users/me?expand=organization');
}
