/* ホーム: 業務プロジェクトの一覧と作成 */
import { listProjects, saveProject, loadSettings } from '../core/store.js';
import { configuredProviders, PROVIDERS } from '../core/ai.js';
import { getAuthState } from '../core/genesysAuth.js';
import { escapeHtml, formatDateTime, newId, toast } from '../core/ui.js';
import { navigate, hooks } from '../core/appState.js';
import { PHASES } from './phases.js';
import { SKILLS, MANUAL_ONLY } from '../sdd/skills.js';
import { storageSettings } from '../core/sync.js';

export async function renderHome(container) {
  const projects = await listProjects();
  const settings = loadSettings();
  const ais = configuredProviders(settings);
  const gc = getAuthState();
  const storage = storageSettings().mode;

  const step = (done, title, body, action) => `
    <li class="setup-step ${done ? 'done' : ''}">
      <span class="setup-check">${done ? '✓' : ''}</span>
      <div><strong>${title}</strong><p>${body}</p></div>
      ${done ? '' : action}
    </li>`;

  container.innerHTML = `
    <section class="hero">
      <div>
        <h1>話すだけで、コンタクトセンターを組み立てる。</h1>
        <p>業務ごとにプロジェクトを作り、AIとイメージをすり合わせてから <strong>設計 → 構築 → テスト → 評価</strong> まで進めます。変更もプロジェクトに話しかけるだけ。</p>
      </div>
      <div class="phase-strip" aria-hidden="true">${PHASES.map(p => `<span class="phase-chip"><span>${p.icon}</span>${p.label}</span>`).join('<span class="phase-arrow">→</span>')}</div>
    </section>

    ${(!ais.length || !gc.connected || storage === 'browser') ? `
    <section class="card">
      <h2 class="card-title">はじめに</h2>
      <ol class="setup-list">
        ${step(ais.length > 0, 'AIを接続する', 'Claude・ChatGPT・Geminiのうち使うもののAPIキーを登録します(キーはこの端末だけに保存)。', '<a class="btn btn-small" href="#/settings">設定へ</a>')}
        ${step(storage !== 'browser', 'データの保存先を決める(おすすめ: GitHub)', '会話や設計書を自分のGitHubリポジトリに保存すると、履歴が残り、別のPCやチームでも続きから作業できます。今はこのブラウザの中だけに保存されています。', '<a class="btn btn-small btn-ghost" href="#/settings">保存先を設定</a>')}
        ${step(gc.connected, 'Genesys Cloudに接続する', 'ご自身のGenesys Cloudアカウントでログインします。ヒアリングと設計だけなら未接続でも進められます。', '<a class="btn btn-small btn-ghost" href="#/settings">接続方法</a>')}
      </ol>
    </section>` : ''}

    <section class="card">
      <div class="card-head">
        <h2 class="card-title">業務プロジェクト</h2>
        <button type="button" class="btn btn-primary" data-act="new">＋ 新しい業務プロジェクト</button>
      </div>
      ${projects.length ? `<div class="project-grid">${projects.map(p => {
        const ph = PHASES.find(x => x.id === (p.phase || 'hearing')) || PHASES[0];
        const ver = p.specVersions?.length || 0;
        return `<a class="project-card" href="#/project/${encodeURIComponent(p.id)}">
          <div class="project-card-top"><span class="badge badge-phase">${ph.icon} ${ph.label}</span>
            <span class="muted small">${escapeHtml(PROVIDERS[p.provider]?.label.split(' ')[0] || '')}</span></div>
          <h3>${escapeHtml(p.name)}</h3>
          <p class="muted">${escapeHtml(p.description || '説明なし')}</p>
          <div class="project-card-foot muted small">${ver ? `設計書 v${ver}` : '設計書 未確定'} ・ 更新 ${formatDateTime(p.updatedAt)}</div>
        </a>`;
      }).join('')}</div>` : `
      <div class="empty">
        <div class="empty-icon">📦</div>
        <p><strong>まだプロジェクトがありません。</strong><br>「〇〇受付業務」のように、業務の単位で箱を作ってください。</p>
        <button type="button" class="btn btn-primary" data-act="new">最初のプロジェクトを作る</button>
      </div>`}
    </section>

    <section class="card">
      <h2 class="card-title">話すだけで作れるもの</h2>
      <div class="skill-grid">${SKILLS.map(s => `<div class="skill-card"><strong>${s.icon} ${escapeHtml(s.label)}</strong><span class="small muted">${escapeHtml(s.builds)}</span></div>`).join('')}</div>
      <details class="memo"><summary>手作業になるもの(${MANUAL_ONLY.length})</summary><ul class="plain small muted">${MANUAL_ONLY.map(m => `<li>・${escapeHtml(m)}</li>`).join('')}</ul></details>
    </section>`;

  container.querySelectorAll('[data-act="new"]').forEach(b => b.addEventListener('click', () => openNewProjectDialog()));
}

export async function openNewProjectDialog() {
  const settings = loadSettings();
  const ais = configuredProviders(settings);
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `
    <form class="modal" role="dialog" aria-modal="true" aria-labelledby="npTitle">
      <h3 id="npTitle">新しい業務プロジェクト</h3>
      <label class="field"><span>業務名 <em class="req">必須</em></span>
        <input name="name" required maxlength="60" placeholder="例: 会員サポート窓口"></label>
      <label class="field"><span>ひとことで言うと</span>
        <input name="description" maxlength="200" placeholder="例: 会員からの登録変更・解約の電話受付"></label>
      <label class="field"><span>使うAI</span>
        <select name="provider">${Object.entries(PROVIDERS).map(([id, p]) =>
          `<option value="${id}" ${ais.includes(id) ? '' : 'disabled'}>${escapeHtml(p.label)}${ais.includes(id) ? '' : '(キー未設定)'}</option>`).join('')}</select></label>
      ${ais.length ? '' : '<p class="note warn">AIのAPIキーが未設定です。作成後に設定画面で登録すれば、そのまま会話を始められます。</p>'}
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" data-act="cancel">キャンセル</button>
        <button type="submit" class="btn btn-primary">作成してヒアリングを始める</button>
      </div>
    </form>`;
  document.body.appendChild(wrap);
  const form = wrap.querySelector('form');
  if (ais.length) form.provider.value = ais[0];
  form.name.focus();
  const close = () => wrap.remove();
  wrap.addEventListener('click', e => {
    if (e.target === wrap || e.target.closest('[data-act="cancel"]')) close();
  });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const name = form.name.value.trim();
    if (!name) return;
    const project = {
      id: newId('prj'), name, description: form.description.value.trim(),
      provider: form.provider.value || 'anthropic',
      phase: 'hearing', createdAt: Date.now(),
      messages: [], specVersions: [], builds: [], testCases: [], evaluations: []
    };
    await saveProject(project);
    close();
    toast(`「${name}」を作成しました`, 'success');
    await hooks.refreshNav();
    navigate(`#/project/${encodeURIComponent(project.id)}`);
  });
}

