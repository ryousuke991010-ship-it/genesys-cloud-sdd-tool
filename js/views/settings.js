/* 設定: AIの接続(APIキー)・Genesys Cloudの接続先・データの書き出し/読み込み */
import { loadSettings, saveSettings, exportAll, importAll } from '../core/store.js';
import { PROVIDERS } from '../core/ai.js';
import { REGIONS, login, isValidClientId, getAuthState } from '../core/genesysAuth.js';
import { getMe } from '../core/gcApi.js';
import { escapeHtml, toast, downloadJson, confirmDialog, setRunState, spinnerHtml, formatDateTime } from '../core/ui.js';
import { MODES, storageSettings, switchMode, pickFolder, currentFolderName, checkGithub, folderSupported, getSyncState, onSyncChange, requestPersist } from '../core/sync.js';
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

    <section class="card" id="storageCard">
      <h2 class="card-title">データの保存先</h2>
      <p class="note">プロジェクト(会話・設計書・構築とテストの記録)の保存先を選べます。どれを選んでも<strong>このアプリの運営側には保存されません</strong>。ブラウザ内にも作業用のコピーが残ります。APIキーはどの保存先にも書き出しません。</p>
      <div class="storage-options" role="radiogroup">
        ${storageOption('github', 'GitHubリポジトリ', '自分のリポジトリにプロジェクトごとのファイルを保存し、変更のたびに履歴(いつ・何を変えたか)が残ります。同じリポジトリを使えばチームで共有でき、別のPCでも続きから作業できます。', false, true)}
        ${storageOption('folder', 'PCのフォルダ', folderSupported() ? 'プロジェクトごとのファイルを自動で保存します。OneDrive・Googleドライブの同期フォルダを選べばクラウドにも残り、他のPCでも開けます(Chrome/Edge)。' : 'このブラウザでは使えません(Chrome または Edge で開いてください)。', !folderSupported())}
        ${storageOption('browser', 'このブラウザだけ', '設定不要。このPCのこのブラウザでだけ見られます。閲覧データの削除や別のPCでは見えません。お試し向け。')}
      </div>
      <div id="storageConfig" class="storage-config"></div>
      <div class="row">
        <span class="muted small" id="storageStatus"></span>
        <span class="spacer"></span>
        <button type="button" class="btn btn-primary" id="storageApply">この保存先に切り替える</button>
      </div>
    </section>

    <section class="card">
      <h2 class="card-title">書き出し・読み込み</h2>
      <p class="note">全プロジェクトを1つのJSONファイルにして、手動でバックアップ・移行できます。書き出したファイルにAPIキーは含まれません。</p>
      <div class="row">
        <button type="button" class="btn btn-ghost" id="exportBtn">すべて書き出す(JSON)</button>
        <label class="btn btn-ghost file-btn">ファイルから読み込む<input type="file" id="importFile" accept="application/json,.json" hidden></label>
      </div>
    </section>`;

  wireStorage(container, { onChange });

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

function storageOption(id, title, desc, disabled = false, recommended = false) {
  const cur = storageSettings().mode;
  return `<label class="storage-option ${cur === id ? 'selected' : ''}">
    <input type="radio" name="storageMode" value="${id}" ${cur === id ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
    <strong>${MODES[id].icon} ${escapeHtml(title)}</strong>${recommended ? ' <span class="badge badge-accent">おすすめ</span>' : ''}${cur === id ? ' <span class="badge badge-success">使用中</span>' : ''}
    <p class="small muted">${escapeHtml(desc)}</p></label>`;
}

/** 保存先の選択・設定・切り替え */
function wireStorage(container, { onChange }) {
  const card = container.querySelector('#storageCard');
  const cfgArea = card.querySelector('#storageConfig');
  const applyBtn = card.querySelector('#storageApply');
  const statusEl = card.querySelector('#storageStatus');
  const saved = storageSettings();
  const draft = { mode: saved.mode, github: { ...saved.github } };
  let folderName = '';
  let githubChecked = saved.mode === 'github';

  const showStatus = async () => {
    const st = getSyncState();
    const persisted = await requestPersist();
    const label = { ok: `保存済み${st.at ? `(${formatDateTime(st.at)})` : ''}`, pending: '書き出し待ち', saving: '処理中…', error: `エラー: ${st.message}`, needsPermission: st.message }[st.status] || '';
    statusEl.textContent = `現在: ${MODES[st.mode].label}${st.mode !== 'browser' && label ? ` — ${label}` : ''}${persisted === true ? '(ブラウザ内のデータは消されにくい設定です)' : ''}`;
  };
  const off = onSyncChange(() => { if (card.isConnected) showStatus(); else off(); });

  const refresh = () => {
    card.querySelectorAll('.storage-option').forEach(o => o.classList.toggle('selected', o.querySelector('input').value === draft.mode));
    const same = draft.mode === saved.mode && (draft.mode !== 'github' || JSON.stringify(draft.github) === JSON.stringify(saved.github));
    applyBtn.textContent = same ? (draft.mode === 'browser' ? '使用中' : '今すぐ同期する') : 'この保存先に切り替える';
    setRunState(applyBtn,
      draft.mode === 'folder' && !folderName ? '保存するフォルダを選ぶ'
        : draft.mode === 'github' && !githubChecked ? '「接続を確認」を押す'
          : same && draft.mode === 'browser' ? '別の保存先を選ぶ' : '');
  };

  const renderCfg = async () => {
    if (draft.mode === 'folder') {
      folderName = await currentFolderName();
      cfgArea.innerHTML = `<div class="row"><span>保存するフォルダ: <strong>${folderName ? escapeHtml(folderName) : '未選択'}</strong></span>
        <button type="button" class="btn btn-small btn-ghost" id="pickFolder">${folderName ? 'フォルダを変える' : 'フォルダを選ぶ'}</button></div>
        <p class="small muted">プロジェクトごとに <code>prj_….json</code> が保存されます。フォルダの中の他のファイルには触りません。ブラウザを開き直した時は、上部の「保存」ボタンでアクセスを再開します。</p>`;
      cfgArea.querySelector('#pickFolder').addEventListener('click', async () => {
        try {
          await pickFolder();
          await renderCfg();
        } catch (e) {
          if (e.name !== 'AbortError') toast(e.message, 'error');
        }
      });
    } else if (draft.mode === 'github') {
      const g = draft.github;
      cfgArea.innerHTML = `<div class="form-grid">
          <label class="field"><span>オーナー(ユーザー名か組織名)</span><input name="ghOwner" value="${escapeHtml(g.owner || '')}" placeholder="例: my-team"></label>
          <label class="field"><span>リポジトリ</span><input name="ghRepo" value="${escapeHtml(g.repo || '')}" placeholder="例: contact-center-designs"></label>
          <label class="field"><span>ブランチ</span><input name="ghBranch" value="${escapeHtml(g.branch || 'main')}"></label>
          <label class="field"><span>保存するフォルダ</span><input name="ghDir" value="${escapeHtml(g.dir ?? 'sdd-projects')}"></label>
          <label class="field"><span>アクセストークン</span><input type="password" name="ghToken" autocomplete="off" value="${escapeHtml(g.token || '')}" placeholder="github_pat_…"></label>
        </div>
        <details class="howto"><summary>トークンの作り方</summary><ol>
          <li>GitHubの「Settings → Developer settings → Fine-grained tokens」で新しいトークンを作る</li>
          <li>Repository access で<strong>保存に使うリポジトリだけ</strong>を選ぶ(非公開リポジトリをおすすめします)</li>
          <li>Permissions の <strong>Contents</strong> を「Read and write」にする</li>
        </ol><p class="small muted">トークンはこの端末のブラウザにだけ保存し、api.github.com にだけ送ります。</p></details>
        <div class="row"><span class="small" id="ghResult"></span><span class="spacer"></span><button type="button" class="btn btn-small btn-ghost" id="ghCheck">接続を確認</button></div>`;
      cfgArea.querySelectorAll('input').forEach(i => i.addEventListener('input', () => {
        Object.assign(draft.github, { owner: v('ghOwner'), repo: v('ghRepo'), branch: v('ghBranch') || 'main', dir: v('ghDir'), token: v('ghToken') });
        githubChecked = false;
        refresh();
      }));
      cfgArea.querySelector('#ghCheck').addEventListener('click', async e => {
        const btn = e.currentTarget;
        const out = cfgArea.querySelector('#ghResult');
        btn.disabled = true;
        out.innerHTML = spinnerHtml('確認中…');
        try {
          const r = await checkGithub(draft.github);
          githubChecked = true;
          out.innerHTML = `<span class="success">✓ ${escapeHtml(r.fullName)} に保存できます${r.private ? '' : '(<strong>公開リポジトリ</strong>です。会話の内容が誰でも見られる点に注意)'}</span>`;
        } catch (err) {
          githubChecked = false;
          out.innerHTML = `<span class="fail">${escapeHtml(err.message)}</span>`;
        } finally {
          btn.disabled = false;
          refresh();
        }
      });
    } else {
      cfgArea.innerHTML = '';
    }
    refresh();
  };
  const v = name => cfgArea.querySelector(`[name="${name}"]`)?.value.trim() || '';

  card.querySelectorAll('[name="storageMode"]').forEach(r => r.addEventListener('change', () => { draft.mode = r.value; renderCfg(); }));
  applyBtn.addEventListener('click', async () => {
    const target = draft.mode === 'folder' ? `フォルダ「${folderName}」` : draft.mode === 'github' ? `GitHub ${draft.github.owner}/${draft.github.repo}(${draft.github.branch} / ${draft.github.dir || 'ルート'})` : 'このブラウザだけ';
    if (draft.mode !== 'browser') {
      const ok = await confirmDialog({
        title: `保存先: ${target}`,
        bodyHtml: `<p>保存先にあるプロジェクトを読み込み(保存先の方が新しいものは手元を置き換えます)、手元のすべてのプロジェクトを保存先に書き出します。</p>
          <p class="muted small">以後、プロジェクトを変更するたびに自動で保存先にも保存します${draft.mode === 'github' ? '(数秒まとめてから1回のコミットで保存)' : ''}。</p>`,
        okLabel: '保存して同期する'
      });
      if (!ok) return;
    }
    applyBtn.disabled = true;
    applyBtn.innerHTML = spinnerHtml('同期中…');
    try {
      const r = await switchMode({ mode: draft.mode, github: draft.github });
      toast(draft.mode === 'browser' ? '保存先をこのブラウザだけにしました(保存先にあるファイルはそのまま残ります)' : `同期しました(保存先の${r.remote}件のうち${r.pulled}件を取り込み)`, 'success');
      await hooks.refreshNav();
      onChange();
      renderSettings(container, { onChange });
    } catch (e) {
      toast(e.message, 'error');
      applyBtn.disabled = false;
      refresh();
    }
  });
  renderCfg();
  showStatus();
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
