/* 設定: AIの接続(APIキー)・Genesys Cloudの接続先・データの書き出し/読み込み */
import { loadSettings, saveSettings, exportAll, importAll } from '../core/store.js';
import { PROVIDERS } from '../core/ai.js';
import { REGIONS, login, isValidClientId, getAuthState } from '../core/genesysAuth.js';
import { getMe } from '../core/gcApi.js';
import { escapeHtml, toast, downloadJson, confirmDialog } from '../core/ui.js';
import { hooks } from '../core/appState.js';

export function renderSettings(container, { onChange }) {
  const s = loadSettings();
  s.ai = s.ai || {};
  s.genesys = s.genesys || {};
  const redirect = location.href.split('#')[0].split('?')[0];

  container.innerHTML = `
    <section class="card">
      <h2 class="card-title">AIの接続</h2>
      <p class="note">ご自身で発行したAPIキーを登録します。キーは<strong>この端末のブラウザにだけ</strong>保存され、各AIのAPIにだけ送られます(このアプリにサーバーはありません)。共有PCでは使い終わったら削除してください。</p>
      <div class="ai-grid">
        ${Object.entries(PROVIDERS).map(([id, p]) => `
        <div class="ai-card ${s.ai[id]?.apiKey ? 'connected' : ''}" data-provider="${id}">
          <div class="ai-card-head"><strong>${escapeHtml(p.label)}</strong>
            <span class="badge ${s.ai[id]?.apiKey ? 'badge-success' : 'badge-muted'}">${s.ai[id]?.apiKey ? '登録済み' : '未登録'}</span></div>
          <label class="field"><span>APIキー</span>
            <input type="password" name="key" autocomplete="off" placeholder="${escapeHtml(p.keyHint)}" value="${escapeHtml(s.ai[id]?.apiKey || '')}"></label>
          <label class="field"><span>モデル</span>
            <input name="model" list="models-${id}" value="${escapeHtml(s.ai[id]?.model || p.defaultModel)}">
            <datalist id="models-${id}">${p.models.map(m => `<option value="${escapeHtml(m)}">`).join('')}</datalist></label>
          <div class="row">
            <a class="link small" href="${p.keyUrl}" target="_blank" rel="noopener noreferrer">キーの発行ページ ↗</a>
            <span class="spacer"></span>
            <button type="button" class="btn btn-small btn-ghost" data-act="clear">削除</button>
            <button type="button" class="btn btn-small btn-primary" data-act="save">保存</button>
          </div>
        </div>`).join('')}
      </div>
    </section>

    <section class="card">
      <h2 class="card-title">Genesys Cloudの接続</h2>
      <p class="note">ログインはGenesys Cloud自身の画面で行い、このアプリはパスワードを扱いません。できる操作は、ログインしたユーザーのロールの範囲に限られます。</p>
      <details class="howto"><summary>事前準備(組織の管理者が1回だけ)</summary>
        <ol>
          <li>Genesys Cloudの「管理 → OAuth」で、付与タイプ「<strong>Code Authorization</strong>」(PKCE)のクライアントを作成</li>
          <li>Authorized redirect URI に <code>${escapeHtml(redirect)}</code> を登録</li>
          <li>スコープ: <code>routing</code> <code>architect</code> <code>users</code> <code>telephony:readonly</code> <code>agentic-virtualagents</code>(構築する範囲に合わせて。ログインする人のロールにも同じ権限が必要です)</li>
          <li>作成されたクライアントIDを下に貼り付け</li>
        </ol>
      </details>
      <div class="form-grid">
        <label class="field"><span>リージョン</span>
          <select name="region">${REGIONS.map(r => `<option value="${r.id}" ${s.genesys.region === r.id ? 'selected' : ''}>${escapeHtml(r.label)}</option>`).join('')}</select></label>
        <label class="field"><span>OAuthクライアントID</span>
          <input name="clientId" autocomplete="off" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" value="${escapeHtml(s.genesys.clientId || '')}"></label>
      </div>
      <div class="row">
        <span class="muted small" id="gcStatus">${getAuthState().connected ? `接続中 (${escapeHtml(getAuthState().region)})` : '未接続'}</span>
        <span class="spacer"></span>
        <button type="button" class="btn btn-primary" id="gcLogin">保存して接続</button>
      </div>
    </section>

    <section class="card">
      <h2 class="card-title">データ</h2>
      <p class="note">プロジェクト(会話・設計書・構築とテストの記録)はこの端末のブラウザ内だけに保存されています。別の端末で使う時やバックアップには書き出してください。書き出したファイルにAPIキーは含まれません。</p>
      <div class="row">
        <button type="button" class="btn btn-ghost" id="exportBtn">すべて書き出す(JSON)</button>
        <label class="btn btn-ghost file-btn">ファイルから読み込む<input type="file" id="importFile" accept="application/json,.json" hidden></label>
      </div>
    </section>`;

  container.querySelectorAll('.ai-card').forEach(card => {
    const id = card.dataset.provider;
    card.querySelector('[data-act="save"]').addEventListener('click', () => {
      const key = card.querySelector('[name="key"]').value.trim();
      const model = card.querySelector('[name="model"]').value.trim() || PROVIDERS[id].defaultModel;
      if (!key) { toast('APIキーを入力してください', 'error'); return; }
      const cur = loadSettings();
      cur.ai = { ...(cur.ai || {}), [id]: { apiKey: key, model } };
      saveSettings(cur);
      toast(`${PROVIDERS[id].label} を保存しました`, 'success');
      onChange();
      renderSettings(container, { onChange });
    });
    card.querySelector('[data-act="clear"]').addEventListener('click', async () => {
      if (!(await confirmDialog({ title: 'APIキーの削除', bodyHtml: `<p>${escapeHtml(PROVIDERS[id].label)} のキーをこの端末から削除します。</p>`, okLabel: '削除する' }))) return;
      const cur = loadSettings();
      if (cur.ai) delete cur.ai[id];
      saveSettings(cur);
      onChange();
      renderSettings(container, { onChange });
    });
  });

  container.querySelector('#gcLogin').addEventListener('click', async e => {
    const region = container.querySelector('[name="region"]').value;
    const clientId = container.querySelector('[name="clientId"]').value.trim();
    if (!isValidClientId(clientId)) { toast('OAuthクライアントIDの形式が正しくありません', 'error'); return; }
    const cur = loadSettings();
    cur.genesys = { region, clientId };
    saveSettings(cur);
    await connect(region, clientId, e.currentTarget);
    renderSettings(container, { onChange });
  });

  container.querySelector('#exportBtn').addEventListener('click', async () => {
    downloadJson(`sdd-projects-${new Date().toISOString().slice(0, 10)}.json`, await exportAll());
  });
  container.querySelector('#importFile').addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const n = await importAll(JSON.parse(await file.text()));
      toast(`${n}件のプロジェクトを読み込みました(同じIDのものは上書き)`, 'success');
      await hooks.refreshNav();
    } catch (err) {
      toast(err.message || '読み込めませんでした', 'error');
    }
    e.target.value = '';
  });
}

async function connect(region, clientId, btn) {
  if (btn) btn.disabled = true;
  try {
    await login({ region, clientId });
    const me = await getMe().catch(() => null);
    toast(me ? `${me.name} として ${me.organization?.name || region} に接続しました` : 'Genesys Cloudに接続しました', 'success');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

/** ヘッダーの「接続」ボタンから。設定済みならそのまま接続、未設定なら設定画面へ */
export function openConnectDialog() {
  const g = loadSettings().genesys || {};
  if (g.region && isValidClientId(g.clientId)) connect(g.region, g.clientId, document.getElementById('gcConnectBtn'));
  else { location.hash = '#/settings'; toast('リージョンとOAuthクライアントIDを設定してください'); }
}
