/* 業務プロジェクト画面: ヒアリング → 設計 → 構築 → テスト → 評価 */
import { getProject, saveProject, deleteProject, loadSettings } from '../core/store.js';
import { chat, extractJson, configuredProviders, PROVIDERS, modelFor } from '../core/ai.js';
import { getAuthState, onAuthChange } from '../core/genesysAuth.js';
import { escapeHtml, spinnerHtml, formatDateTime, toast, confirmDialog, setRunState, renderRichText, newId, downloadJson } from '../core/ui.js';
import { setBusy, navigate, hooks } from '../core/appState.js';
import { normalizeSpec, lintSpec, diffSpecs, simulateCall, DAY_LABEL } from '../sdd/spec.js';
import { hearingSystem, specSystem, testCaseSystem, evaluateSystem } from '../sdd/prompts.js';
import { buildPlan, executePlan, verifyPlan, flowBuildMemo, TYPE_LABEL } from '../sdd/builder.js';
import { PHASES } from './phases.js';

export async function renderProject(container, id, { setTitle }) {
  let project = await getProject(id);
  if (!project) {
    setTitle('見つかりません');
    container.innerHTML = `<section class="card empty"><p>このプロジェクトは見つかりませんでした(削除されたか、別の端末で作られたものです)。</p><a class="btn btn-primary" href="#/">ホームへ</a></section>`;
    return undefined;
  }
  setTitle(project.name);
  let alive = true;
  const save = async () => { project = await saveProject(project); };
  const latest = () => project.specVersions[project.specVersions.length - 1] || null;
  const off = onAuthChange(() => { if (alive && ['build', 'test'].includes(project.phase)) renderBody(); });

  /** AI呼び出し中は画面移動を確認させ、ボタンを止める */
  async function withAi(btn, label, fn) {
    const old = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = spinnerHtml(label);
    setBusy(true);
    try {
      return await fn();
    } catch (e) {
      toast(e.message, 'error');
      return undefined;
    } finally {
      setBusy(false);
      if (alive) { btn.disabled = false; btn.innerHTML = old; }
    }
  }
  const ask = (system, messages) => chat({ settings: loadSettings(), provider: project.provider, system, messages });

  function renderShell() {
    const settings = loadSettings();
    const ais = configuredProviders(settings);
    const v = latest();
    const idx = PHASES.findIndex(p => p.id === project.phase);
    container.innerHTML = `
      <section class="card project-head">
        <div class="project-head-top">
          <div>
            <h1 class="project-title">${escapeHtml(project.name)}</h1>
            <p class="muted">${escapeHtml(project.description || '')}</p>
          </div>
          <div class="project-head-meta">
            <label class="field inline"><span>AI</span>
              <select id="providerSel">${Object.entries(PROVIDERS).map(([pid, p]) =>
                `<option value="${pid}" ${pid === project.provider ? 'selected' : ''} ${ais.includes(pid) ? '' : 'disabled'}>${escapeHtml(p.label)}${ais.includes(pid) ? ` · ${escapeHtml(modelFor(settings, pid))}` : '(未設定)'}</option>`).join('')}</select></label>
            <span class="badge ${v ? 'badge-success' : 'badge-muted'}">${v ? `設計書 v${v.version}` : '設計書 未確定'}</span>
            <button type="button" class="btn btn-small btn-ghost" id="exportPrj" title="このプロジェクトだけを書き出す">書き出し</button>
            <button type="button" class="btn btn-small btn-ghost danger-text" id="deletePrj">削除</button>
          </div>
        </div>
        <ol class="stepper" role="tablist">
          ${PHASES.map((p, i) => `<li><button type="button" role="tab" class="step ${p.id === project.phase ? 'active' : ''} ${i < idx ? 'past' : ''}" data-phase="${p.id}" aria-selected="${p.id === project.phase}">
            <span class="step-icon">${p.icon}</span><span class="step-label">${p.label}</span></button></li>`).join('')}
        </ol>
        <p class="phase-desc">${escapeHtml(PHASES[idx]?.desc || '')}</p>
      </section>
      <div id="phaseBody"></div>`;

    container.querySelector('#providerSel').addEventListener('change', async e => {
      project.provider = e.target.value;
      await save();
      toast(`このプロジェクトのAIを ${PROVIDERS[project.provider].label} に切り替えました`);
    });
    container.querySelectorAll('.step').forEach(b => b.addEventListener('click', () => go(b.dataset.phase)));
    container.querySelector('#exportPrj').addEventListener('click', () => {
      downloadJson(`${project.name}.sdd.json`, { format: 'gc-sdd-export', version: 1, exportedAt: new Date().toISOString(), projects: [project] });
    });
    container.querySelector('#deletePrj').addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'プロジェクトの削除',
        bodyHtml: `<p>「${escapeHtml(project.name)}」の会話・設計書・記録をこの端末から削除します。<br>Genesys Cloudに構築済みの設定は<strong>削除されません</strong>。</p>`,
        okLabel: '削除する', danger: true, requireText: project.name
      });
      if (!ok) return;
      await deleteProject(project.id);
      await hooks.refreshNav();
      navigate('#/');
    });
    renderBody();
  }

  async function go(phase) {
    project.phase = phase;
    await save();
    await hooks.refreshNav();
    renderShell();
  }

  function renderBody() {
    const body = container.querySelector('#phaseBody');
    if (!body) return;
    ({ hearing: renderHearing, design: renderDesign, build: renderBuild, test: renderTest, evaluate: renderEvaluate }[project.phase] || renderHearing)(body);
  }

  /* ================= ヒアリング ================= */
  let awaitingReply = false;
  function renderHearing(body) {
    const v = latest();
    const examples = v
      ? ['土曜日も10時〜15時で受け付けたい', '「3」で請求の問い合わせを追加して専用キューに', '年末年始(12/29〜1/3)を休業日にしたい']
      : ['会員向けの電話窓口。平日9時〜18時、土日祝は休み', '「1」で登録変更、「2」で解約の相談に分けたい', '解約は経験者だけが受けるようにしたい'];
    body.innerHTML = `
      <section class="card chat-card">
        ${v ? `<div class="banner">設計書 <strong>v${v.version}</strong> が確定済みです。変えたいことをそのまま話しかけてください。会話が終わったら「設計書を更新」で新しい版を作ります。</div>` : ''}
        <div class="chat-log" id="chatLog" aria-live="polite">
          ${project.messages.length ? project.messages.map(m => `
            <div class="msg msg-${m.role}">
              <div class="msg-meta">${m.role === 'user' ? 'あなた' : escapeHtml(PROVIDERS[m.provider]?.label.split(' ')[0] || 'AI')} · ${formatDateTime(m.at)}</div>
              <div class="msg-body">${renderRichText(m.content)}</div>
            </div>`).join('') : `
            <div class="chat-empty">
              <p><strong>この業務について、思いつくままに話してください。</strong><br>AIが質問しながら、営業時間・分岐・受付窓口などを一緒に整理します。</p>
              <div class="chips">${examples.map(x => `<button type="button" class="chip" data-example="${escapeHtml(x)}">${escapeHtml(x)}</button>`).join('')}</div>
            </div>`}
        </div>
        ${project.messages.length ? `<div class="chips chips-tight">${examples.map(x => `<button type="button" class="chip" data-example="${escapeHtml(x)}">${escapeHtml(x)}</button>`).join('')}</div>` : ''}
        <form class="composer" id="composer">
          <textarea id="chatInput" rows="3" placeholder="例: 平日は9時から18時。1を押したら注文、2を押したら返品の窓口につなぎたい(Ctrl+Enterで送信)"></textarea>
          <div class="composer-actions">
            <button type="submit" class="btn btn-primary" id="sendBtn">送信</button>
          </div>
        </form>
        <div class="bulk-run">
          <button type="button" class="btn btn-accent" id="toSpecBtn">${v ? '会話の内容で設計書を更新 →' : 'ここまでの会話で設計書を作成 →'}</button>
        </div>
      </section>`;

    const log = body.querySelector('#chatLog');
    log.scrollTop = log.scrollHeight;
    const input = body.querySelector('#chatInput');
    const sendBtn = body.querySelector('#sendBtn');
    const toSpecBtn = body.querySelector('#toSpecBtn');
    const hasAi = configuredProviders(loadSettings()).includes(project.provider);
    const lastIsUser = project.messages.length && project.messages[project.messages.length - 1].role === 'user';
    setRunState(sendBtn, hasAi ? '' : '設定画面でAIのAPIキーを登録する');
    setRunState(toSpecBtn, !hasAi ? 'AIを設定する' : !project.messages.length ? 'まず業務について会話する' : '');
    body.querySelectorAll('[data-example]').forEach(c => c.addEventListener('click', () => { input.value = c.dataset.example; input.focus(); }));
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) body.querySelector('#composer').requestSubmit(); });
    if (lastIsUser && !awaitingReply) toast('前回の送信にAIの返答がありません。もう一度送信してください。');

    body.querySelector('#composer').addEventListener('submit', async e => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text || sendBtn.disabled) return;
      // 返答が無いまま残ったユーザー発言は、今回の発言と1つにまとめる(user/assistantを交互に保つ)
      const prev = project.messages[project.messages.length - 1];
      if (prev?.role === 'user') prev.content += `\n${text}`;
      else project.messages.push({ role: 'user', content: text, at: Date.now() });
      await save();
      input.value = '';
      awaitingReply = true;
      renderHearing(body);
      const btn = body.querySelector('#sendBtn');
      const reply = await withAi(btn, 'AIが考えています…', () =>
        ask(hearingSystem(project, latest()?.spec), project.messages.map(m => ({ role: m.role, content: m.content }))));
      awaitingReply = false;
      if (reply && alive) {
        project.messages.push({ role: 'assistant', content: reply, at: Date.now(), provider: project.provider });
        await save();
        if (project.phase === 'hearing') renderHearing(body);
      }
    });

    toSpecBtn.addEventListener('click', async () => {
      const convo = project.messages.map(m => ({ role: m.role, content: m.content }));
      if (convo[convo.length - 1]?.role === 'user') convo.push({ role: 'assistant', content: '(承知しました)' });
      convo.push({ role: 'user', content: 'ここまでの会話をもとに、設計書のJSONを作成してください。' });
      const reply = await withAi(toSpecBtn, '設計書を作成中…', () => ask(specSystem(project, latest()?.spec), convo));
      if (!reply || !alive) return;
      try {
        project.draftSpec = { spec: normalizeSpec(extractJson(reply)), at: Date.now(), provider: project.provider };
        await save();
        go('design');
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  }

  /* ================= 設計 ================= */
  function specHtml(spec) {
    const list = (arr, empty = '未設定') => arr.length ? arr.map(x => `<span class="tag">${escapeHtml(x)}</span>`).join('') : `<span class="muted">${empty}</span>`;
    const act = a => !a ? '<span class="muted">未設定</span>' : a.action === 'queue' ? `→ キュー <strong>${escapeHtml(a.target)}</strong>` : a.action === 'message' ? `🔊 ${escapeHtml(a.target)}` : '✕ 切断';
    return `
      <div class="spec-grid">
        <div class="spec-block"><h4>業務</h4><p><strong>${escapeHtml(spec.business.name)}</strong></p><p class="muted">${escapeHtml(spec.business.summary)}</p><p class="small muted">タイムゾーン: ${escapeHtml(spec.timeZone)}</p></div>
        <div class="spec-block"><h4>営業時間</h4>${spec.hours.length ? `<ul class="plain">${spec.hours.map(h => `<li><strong>${escapeHtml(h.name)}</strong> ${h.days.map(d => DAY_LABEL[d]).join('')} ${escapeHtml(h.open)}〜${escapeHtml(h.close)}</li>`).join('')}</ul>` : '<span class="muted">未設定</span>'}</div>
        <div class="spec-block"><h4>休業日</h4>${spec.holidays.length ? `<ul class="plain">${spec.holidays.map(h => `<li>${escapeHtml(h.date)} ${escapeHtml(h.name)}</li>`).join('')}</ul>` : '<span class="muted">未設定</span>'}</div>
        <div class="spec-block"><h4>キュー</h4>${spec.queues.length ? `<ul class="plain">${spec.queues.map(q => `<li><strong>${escapeHtml(q.name)}</strong> <span class="muted">${escapeHtml(q.description)}</span>${q.skills.length ? `<div>${list(q.skills)}</div>` : ''}</li>`).join('')}</ul>` : '<span class="muted">未設定</span>'}</div>
        <div class="spec-block"><h4>ACDスキル</h4>${list(spec.skills)}</div>
        <div class="spec-block"><h4>後処理コード</h4>${list(spec.wrapupCodes)}</div>
        <div class="spec-block spec-wide"><h4>着信フロー(IVR)</h4>
          <div class="ivr">
            <div class="ivr-node">📞 着信</div>
            <div class="ivr-branches">
              <div class="ivr-branch muted">休業日 → 🔊 ${escapeHtml(spec.ivr.holidayMessage || '未設定')}</div>
              <div class="ivr-branch muted">時間外 → 🔊 ${escapeHtml(spec.ivr.afterHoursMessage || '未設定')}</div>
              <div class="ivr-branch"><div>営業中 → 🔊 ${escapeHtml(spec.ivr.greeting || '(アナウンスなし)')}</div>
                <ul class="ivr-menu">${spec.ivr.menu.map(m => `<li><span class="digit">${escapeHtml(m.digit)}</span>${escapeHtml(m.label)} ${act(m)}</li>`).join('')}
                <li><span class="digit">…</span>無入力・該当なし ${act(spec.ivr.noInput)}</li></ul></div>
            </div>
          </div>
        </div>
        ${spec.openQuestions.length ? `<div class="spec-block spec-wide warn-block"><h4>未決事項</h4><ul class="plain">${spec.openQuestions.map(q => `<li>❓ ${escapeHtml(q)}</li>`).join('')}</ul></div>` : ''}
      </div>`;
  }

  function issuesHtml(issues) {
    if (!issues.length) return '<p class="success">✓ 機械的な検査で問題は見つかりませんでした。</p>';
    return `<ul class="issues">${issues.map(i => `<li class="issue-${i.level}"><span class="badge ${i.level === 'error' ? 'badge-danger' : 'badge-warn'}">${i.level === 'error' ? '要修正' : '注意'}</span>${escapeHtml(i.text)}</li>`).join('')}</ul>`;
  }

  function simulatorHtml() {
    const today = new Date();
    const p = n => String(n).padStart(2, '0');
    return `
      <div class="sim">
        <div class="sim-form">
          <label class="field"><span>日付</span><input type="date" id="simDate" value="${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}"></label>
          <label class="field"><span>時刻</span><input type="time" id="simTime" value="10:00"></label>
          <label class="field"><span>押す番号</span><input id="simDigit" maxlength="1" placeholder="空=無入力" class="narrow"></label>
          <button type="button" class="btn btn-ghost" id="simRun">着信をシミュレート</button>
        </div>
        <ol class="sim-steps" id="simOut"><li class="muted">日時と番号を入れて実行すると、設計どおりの流れを表示します(組織には触りません)。</li></ol>
      </div>`;
  }

  function wireSimulator(root, spec) {
    root.querySelector('#simRun').addEventListener('click', () => {
      const r = simulateCall(spec, { date: root.querySelector('#simDate').value, time: root.querySelector('#simTime').value, digit: root.querySelector('#simDigit').value.trim() });
      root.querySelector('#simOut').innerHTML = r.steps.map(s => `<li>${escapeHtml(s)}</li>`).join('');
    });
  }

  function renderDesign(body) {
    const draft = project.draftSpec;
    const v = latest();
    const shown = draft?.spec || v?.spec;
    if (!shown) {
      body.innerHTML = `<section class="card empty"><div class="empty-icon">📐</div><p><strong>まだ設計書がありません。</strong><br>ヒアリングで業務について話してから「設計書を作成」を押してください。</p>
        <button type="button" class="btn btn-primary" id="backHearing">ヒアリングへ</button></section>`;
      body.querySelector('#backHearing').addEventListener('click', () => go('hearing'));
      return;
    }
    const issues = lintSpec(shown);
    const errors = issues.filter(i => i.level === 'error').length;
    const diff = draft && v ? diffSpecs(v.spec, draft.spec) : null;
    body.innerHTML = `
      <section class="card">
        <div class="card-head">
          <h2 class="card-title">${draft ? `設計書の案 <span class="badge badge-warn">未確定</span>` : `設計書 v${v.version} <span class="badge badge-success">確定</span>`}</h2>
          <span class="muted small">${draft ? `${formatDateTime(draft.at)} に ${escapeHtml(PROVIDERS[draft.provider]?.label || '')} が作成` : `${formatDateTime(v.at)} に確定`}</span>
        </div>
        ${diff ? `<div class="diff"><strong>v${v.version} からの変更:</strong> ${diff.length ? diff.map(d => `<span class="tag tag-${d.kind}">${d.kind === 'add' ? '追加' : d.kind === 'remove' ? '削除' : '変更'} ${escapeHtml(d.label)}「${escapeHtml(d.name)}」</span>`).join('') : '<span class="muted">変更なし</span>'}</div>` : ''}
        ${specHtml(shown)}
      </section>
      <div class="bulk-layout">
        <section class="card">
          <h3 class="bulk-col-title">検査結果</h3>
          ${issuesHtml(issues)}
          <details class="json-edit"><summary>設計書(JSON)を直接直す</summary>
            <textarea id="specJson" rows="16" spellcheck="false">${escapeHtml(JSON.stringify(shown, null, 2))}</textarea>
            <button type="button" class="btn btn-small btn-ghost" id="applyJson">この内容を案として反映</button>
          </details>
        </section>
        <section class="card">
          <h3 class="bulk-col-title">着信シミュレーター</h3>
          ${simulatorHtml()}
        </section>
      </div>
      <section class="card">
        <div class="bulk-run">
          <button type="button" class="btn btn-ghost" id="backHearing">← ヒアリングに戻って直す</button>
          ${draft ? `${v ? '<button type="button" class="btn btn-ghost" id="discardDraft">案を破棄</button>' : ''}<button type="button" class="btn btn-primary" id="commitBtn">この設計で確定(v${(v?.version || 0) + 1})</button>`
            : '<button type="button" class="btn btn-primary" id="toBuild">構築へ進む →</button>'}
        </div>
        ${v && project.specVersions.length > 1 ? `<details class="history"><summary>版の履歴(${project.specVersions.length})</summary><ul class="plain">${[...project.specVersions].reverse().map(x => `<li>v${x.version} · ${formatDateTime(x.at)}${x.note ? ` · ${escapeHtml(x.note)}` : ''}</li>`).join('')}</ul></details>` : ''}
      </section>`;

    wireSimulator(body, shown);
    body.querySelector('#backHearing').addEventListener('click', () => go('hearing'));
    body.querySelector('#applyJson').addEventListener('click', async () => {
      try {
        project.draftSpec = { spec: normalizeSpec(JSON.parse(body.querySelector('#specJson').value)), at: Date.now(), provider: 'manual' };
        await save();
        renderDesign(body);
        toast('手直しを案として反映しました');
      } catch {
        toast('JSONの形式が正しくありません', 'error');
      }
    });
    body.querySelector('#discardDraft')?.addEventListener('click', async () => {
      delete project.draftSpec;
      await save();
      renderDesign(body);
    });
    const commitBtn = body.querySelector('#commitBtn');
    if (commitBtn) {
      setRunState(commitBtn, errors ? `検査の「要修正」${errors}件を直す` : '');
      commitBtn.addEventListener('click', async () => {
        const version = (v?.version || 0) + 1;
        const note = diff ? diff.map(d => `${d.label}${d.kind === 'add' ? '追加' : d.kind === 'remove' ? '削除' : '変更'}`).slice(0, 4).join('・') : '初版';
        project.specVersions.push({ version, spec: draft.spec, at: Date.now(), note });
        delete project.draftSpec;
        await save();
        toast(`設計書 v${version} を確定しました`, 'success');
        renderShell();
      });
    }
    body.querySelector('#toBuild')?.addEventListener('click', () => go('build'));
  }

  /* ================= 構築 ================= */
  function lastBuild() { return project.builds[project.builds.length - 1] || null; }

  function planTable(items, withResult) {
    const statusBadge = it => {
      if (withResult) {
        return { created: '<span class="badge badge-success">作成した</span>', skipped: '<span class="badge badge-muted">既存のため触らず</span>', manual: '<span class="badge badge-warn">手動</span>', error: '<span class="badge badge-danger">失敗</span>' }[it.result] || '';
      }
      return { create: '<span class="badge badge-accent">作成する</span>', exists: '<span class="badge badge-muted">既存(触らない)</span>', manual: '<span class="badge badge-warn">Architectで手動</span>', error: '<span class="badge badge-danger">確認できず</span>' }[it.status] || '';
    };
    return `<table class="table"><thead><tr><th>種類</th><th>名前</th><th>${withResult ? '結果' : '計画'}</th><th>補足</th></tr></thead><tbody>
      ${items.map(it => `<tr><td>${escapeHtml(TYPE_LABEL[it.type])}</td><td>${escapeHtml(it.name)}</td><td>${statusBadge(it)}</td><td class="small ${it.error ? 'fail' : 'muted'}">${escapeHtml(it.error || '')}</td></tr>`).join('')}
    </tbody></table>`;
  }

  function renderBuild(body) {
    const v = latest();
    const gc = getAuthState();
    const b = lastBuild();
    if (!v) {
      body.innerHTML = `<section class="card empty"><div class="empty-icon">🛠</div><p><strong>確定した設計書がありません。</strong><br>設計の工程で設計書を確定してから構築します。</p><button type="button" class="btn btn-primary" id="toDesign">設計へ</button></section>`;
      body.querySelector('#toDesign').addEventListener('click', () => go('design'));
      return;
    }
    let plan = null;
    body.innerHTML = `
      <div class="bulk-layout">
        <section class="card">
          <h3 class="bulk-col-title">何を作るか</h3>
          <p>設計書 <strong>v${v.version}</strong> の内容を、${gc.connected ? `接続中の組織(${escapeHtml(gc.region)})` : 'Genesys Cloud'}に構築します。</p>
          <ul class="plain small muted">
            <li>・同じ名前のものが既にあれば<strong>触りません</strong>(上書き・削除はしない)</li>
            <li>・スケジュールには業務名が先頭に付きます(例: ${escapeHtml(v.spec.business.name)}_平日営業)</li>
            <li>・着信フロー(IVR)はAPIで作れないため、Architectでの手順メモを出します</li>
          </ul>
          ${project.draftSpec ? '<p class="note warn">未確定の設計書の案があります。案の内容は構築されません(確定済みの版だけが対象)。</p>' : ''}
        </section>
        <section class="card">
          <h3 class="bulk-col-title">組織の現状と計画</h3>
          <div id="planArea"><p class="muted">「計画を作成」を押すと、組織に既にあるものを名前で確認します(この時点では何も変更しません)。</p></div>
          <div class="bulk-run">
            <button type="button" class="btn btn-ghost" id="planBtn">計画を作成(組織を確認)</button>
            <button type="button" class="btn btn-primary" id="runBtn">構築を実行</button>
          </div>
        </section>
      </div>
      <section class="card" id="resultCard" ${b ? '' : 'hidden'}>
        <div class="card-head"><h3 class="card-title">前回の構築結果</h3><span class="muted small" id="resultMeta">${b ? `設計書 v${b.version} · ${formatDateTime(b.at)}` : ''}</span></div>
        <div id="resultArea">${b ? planTable(b.items, true) : ''}</div>
        <details class="memo" ${b ? 'open' : ''}><summary>Architectでの着信フロー構築メモ</summary><pre class="code" id="memo">${escapeHtml(flowBuildMemo(v.spec))}</pre></details>
        <div class="bulk-run"><button type="button" class="btn btn-accent" id="toTest">テストへ進む →</button></div>
      </section>`;

    const planBtn = body.querySelector('#planBtn');
    const runBtn = body.querySelector('#runBtn');
    const planArea = body.querySelector('#planArea');
    const refreshRun = () => setRunState(runBtn,
      !gc.connected ? 'Genesys Cloudに接続する'
        : !plan ? '先に計画を作成する'
          : !plan.some(i => i.status === 'create') ? '作成するものがありません' : '');
    setRunState(planBtn, gc.connected ? '' : 'Genesys Cloudに接続する');
    refreshRun();
    body.querySelector('#toTest').addEventListener('click', () => go('test'));

    planBtn.addEventListener('click', async () => {
      plan = null;
      refreshRun();
      planBtn.disabled = true;
      setBusy(true);
      try {
        const items = await buildPlan(v.spec, msg => { if (alive) planArea.innerHTML = `<p>${spinnerHtml(msg)}</p>`; });
        if (!alive) return;
        plan = items;
        const c = items.filter(i => i.status === 'create').length;
        const errs = items.filter(i => i.status === 'error').length;
        planArea.innerHTML = `<p><strong>${c}件</strong>を新しく作成します。${errs ? `<span class="fail">${errs}件は組織の状態を確認できませんでした(実行対象外)。</span>` : ''}</p>${planTable(items, false)}`;
      } catch (e) {
        planArea.innerHTML = `<p class="fail">${escapeHtml(e.message)}</p>`;
      } finally {
        setBusy(false);
        if (alive) { planBtn.disabled = false; refreshRun(); }
      }
    });

    runBtn.addEventListener('click', async () => {
      // 確認した時点の計画と設計書を確定させて実行する(実行中に画面の状態が変わっても対象は変わらない)
      const items = plan.map(i => ({ ...i }));
      const spec = v.spec;
      const targets = items.filter(i => i.status === 'create');
      const ok = await confirmDialog({
        title: `Genesys Cloudに${targets.length}件を作成します`,
        bodyHtml: `<p>接続先: <strong>${escapeHtml(gc.region)}</strong> / 設計書 v${v.version}</p>
          <ul class="confirm-list">${targets.map(t => `<li>${escapeHtml(TYPE_LABEL[t.type])}「${escapeHtml(t.name)}」</li>`).join('')}</ul>
          <p class="muted small">既存のものは変更しません。作成したものはこのアプリからは削除できません(Genesys Cloudの管理画面で削除します)。</p>`,
        okLabel: `${targets.length}件を作成する`,
        requireText: targets.length >= 20 ? String(targets.length) : ''
      });
      if (!ok) return;
      runBtn.disabled = true;
      planBtn.disabled = true;
      setBusy(true);
      try {
        await executePlan(spec, items, msg => { if (alive) planArea.innerHTML = `<p>${spinnerHtml(msg)}</p>`; });
        project.builds.push({ id: newId('bld'), version: v.version, at: Date.now(), region: gc.region, items });
        await save();
        const failed = items.filter(i => i.result === 'error').length;
        toast(failed ? `構築が完了しました(${failed}件失敗)。結果を確認してください` : '構築が完了しました', failed ? 'error' : 'success');
      } finally {
        setBusy(false);
      }
      if (alive && project.phase === 'build') renderBuild(body);
    });
  }

  /* ================= テスト ================= */
  function renderTest(body) {
    const v = latest();
    const b = lastBuild();
    const gc = getAuthState();
    if (!v) {
      body.innerHTML = '<section class="card empty"><p>確定した設計書がありません。</p></section>';
      return;
    }
    const cases = project.testCases;
    const pass = cases.filter(c => c.status === 'pass').length;
    const fail = cases.filter(c => c.status === 'fail').length;
    body.innerHTML = `
      <div class="bulk-layout">
        <section class="card">
          <h3 class="bulk-col-title">構築結果の検証</h3>
          <p class="small muted">${b ? `最新の構築(設計書 v${b.version} · ${formatDateTime(b.at)})を組織から取り直し、設計書どおりかを確認します。` : 'まだ構築していません。'}</p>
          ${b && b.version !== v.version ? `<p class="note warn">最新の設計書はv${v.version}ですが、構築はv${b.version}です。変更分を構築してから検証してください。</p>` : ''}
          <div id="verifyArea">${project.lastVerify ? verifyHtml(project.lastVerify) : ''}</div>
          <div class="bulk-run"><button type="button" class="btn btn-ghost" id="verifyBtn">組織から取り直して検証</button></div>
        </section>
        <section class="card">
          <h3 class="bulk-col-title">着信シミュレーター</h3>
          ${simulatorHtml()}
        </section>
      </div>
      <section class="card">
        <div class="card-head">
          <h3 class="card-title">テスト通話シナリオ</h3>
          <span class="muted small">${cases.length ? `合格 ${pass} / 不合格 ${fail} / 未実施 ${cases.length - pass - fail}` : ''}</span>
        </div>
        <p class="small muted">「設計の判定」は設計書から機械的に出した結果です。実際に電話をかけて確かめ、結果を記録してください。</p>
        ${cases.length ? `<table class="table"><thead><tr><th>シナリオ</th><th>日時・番号</th><th>期待する結果</th><th>設計の判定</th><th>実際の結果</th><th>メモ</th></tr></thead><tbody>
          ${cases.map(c => {
            const sim = simulateCall(v.spec, c);
            return `<tr data-case="${escapeHtml(c.id)}">
              <td>${escapeHtml(c.title)}</td>
              <td class="small">${escapeHtml(c.date)} ${escapeHtml(c.time)}<br>${c.digit ? `「${escapeHtml(c.digit)}」` : '無入力'}</td>
              <td class="small">${escapeHtml(c.expected)}</td>
              <td class="small">${escapeHtml(sim.steps[sim.steps.length - 1])}</td>
              <td><select data-field="status" data-plain>
                <option value="todo" ${c.status === 'todo' ? 'selected' : ''}>未実施</option>
                <option value="pass" ${c.status === 'pass' ? 'selected' : ''}>合格</option>
                <option value="fail" ${c.status === 'fail' ? 'selected' : ''}>不合格</option></select></td>
              <td><input data-field="memo" value="${escapeHtml(c.memo || '')}" placeholder="気づいたこと"></td>
            </tr>`;
          }).join('')}</tbody></table>` : '<div class="empty small"><p>まだシナリオがありません。AIに設計書から作らせるか、手で追加してください。</p></div>'}
        <div class="bulk-run">
          <button type="button" class="btn btn-ghost" id="addCase">手で追加</button>
          <button type="button" class="btn btn-primary" id="genCases">AIでシナリオを作成${cases.length ? '(置き換え)' : ''}</button>
          <button type="button" class="btn btn-accent" id="toEval">評価へ進む →</button>
        </div>
      </section>`;

    wireSimulator(body, v.spec);
    body.querySelector('#toEval').addEventListener('click', () => go('evaluate'));
    const verifyBtn = body.querySelector('#verifyBtn');
    setRunState(verifyBtn, !b ? '先に構築する' : !gc.connected ? 'Genesys Cloudに接続する' : '');
    verifyBtn.addEventListener('click', async () => {
      const area = body.querySelector('#verifyArea');
      verifyBtn.disabled = true;
      setBusy(true);
      try {
        const results = await verifyPlan(v.spec, b.items.map(i => ({ ...i })), msg => { if (alive) area.innerHTML = `<p>${spinnerHtml(msg)}</p>`; });
        project.lastVerify = { at: Date.now(), version: b.version, results };
        await save();
        if (alive) area.innerHTML = verifyHtml(project.lastVerify);
      } catch (e) {
        area.innerHTML = `<p class="fail">${escapeHtml(e.message)}</p>`;
      } finally {
        setBusy(false);
        if (alive) verifyBtn.disabled = false;
      }
    });

    body.querySelectorAll('[data-case]').forEach(row => {
      const c = cases.find(x => x.id === row.dataset.case);
      row.querySelector('[data-field="status"]').addEventListener('change', async e => { c.status = e.target.value; await save(); renderTest(body); });
      row.querySelector('[data-field="memo"]').addEventListener('change', async e => { c.memo = e.target.value; await save(); });
    });
    body.querySelector('#addCase').addEventListener('click', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const title = prompt('シナリオ名(例: 平日10時に1を押す)');
      if (!title) return;
      cases.push({ id: newId('tc'), title, date: today, time: '10:00', digit: '', expected: '', status: 'todo', memo: '' });
      await save();
      renderTest(body);
    });
    const genBtn = body.querySelector('#genCases');
    setRunState(genBtn, configuredProviders(loadSettings()).includes(project.provider) ? '' : 'AIを設定する');
    genBtn.addEventListener('click', async () => {
      if (cases.length && !(await confirmDialog({ title: 'シナリオの置き換え', bodyHtml: `<p>今の${cases.length}件(記録した結果を含む)を、AIが作る新しいシナリオで置き換えます。</p>`, okLabel: '置き換える', danger: true }))) return;
      const reply = await withAi(genBtn, 'シナリオを作成中…', () =>
        ask(testCaseSystem(), [{ role: 'user', content: `今日は${new Date().toISOString().slice(0, 10)}です。次の設計書のテストシナリオを作ってください。\n\`\`\`json\n${JSON.stringify(v.spec, null, 2)}\n\`\`\`` }]));
      if (!reply || !alive) return;
      try {
        const list = extractJson(reply)?.cases;
        if (!Array.isArray(list) || !list.length) throw new Error('AIの返答にシナリオが含まれていませんでした。もう一度お試しください。');
        project.testCases = list.map(x => ({
          id: newId('tc'), title: String(x.title || ''), date: String(x.date || ''), time: String(x.time || ''),
          digit: String(x.digit || '').slice(0, 1), expected: String(x.expected || ''), status: 'todo', memo: ''
        }));
        await save();
        renderTest(body);
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  }

  function verifyHtml(vr) {
    const ok = vr.results.filter(r => r.ok === true).length;
    const ng = vr.results.filter(r => r.ok === false).length;
    return `<p class="small">${formatDateTime(vr.at)} の検証: <span class="success">一致 ${ok}</span> / <span class="fail">不一致 ${ng}</span></p>
      <table class="table"><thead><tr><th>種類</th><th>名前</th><th>結果</th></tr></thead><tbody>
      ${vr.results.map(r => `<tr><td>${escapeHtml(TYPE_LABEL[r.type])}</td><td>${escapeHtml(r.name)}</td><td class="small ${r.ok === true ? 'success' : r.ok === false ? 'fail' : 'muted'}">${r.ok === true ? '✓ ' : r.ok === false ? '✕ ' : ''}${escapeHtml(r.detail)}</td></tr>`).join('')}
      </tbody></table>`;
  }

  /* ================= 評価 ================= */
  function renderEvaluate(body) {
    const v = latest();
    const last = project.evaluations[project.evaluations.length - 1];
    const issues = v ? lintSpec(v.spec) : [];
    const b = lastBuild();
    const cases = project.testCases;
    const metric = (label, value, sub) => `<div class="metric"><div class="metric-value">${value}</div><div class="metric-label">${label}</div>${sub ? `<div class="metric-sub">${sub}</div>` : ''}</div>`;
    body.innerHTML = `
      <section class="card">
        <div class="metrics">
          ${metric('設計書', v ? `v${v.version}` : '—', v ? formatDateTime(v.at) : '未確定')}
          ${metric('検査の指摘', v ? issues.length : '—', v ? `要修正 ${issues.filter(i => i.level === 'error').length}` : '')}
          ${metric('構築', b ? `${b.items.filter(i => i.result === 'created' || i.result === 'skipped').length}/${b.items.filter(i => i.type !== 'flow').length}` : '—', b ? `v${b.version}を構築` : '未構築')}
          ${metric('テスト', cases.length ? `${cases.filter(c => c.status === 'pass').length}/${cases.length}` : '—', cases.length ? `不合格 ${cases.filter(c => c.status === 'fail').length}` : '未作成')}
        </div>
        <div class="bulk-run"><button type="button" class="btn btn-primary" id="evalBtn">AIで評価する</button></div>
      </section>
      <section class="card">
        ${last ? `<div class="card-head"><h3 class="card-title">評価結果</h3><span class="muted small">${formatDateTime(last.at)} · ${escapeHtml(PROVIDERS[last.provider]?.label || '')} · 設計書 v${last.version}</span></div>
          <div class="eval-body">${renderRichText(last.content)}</div>
          <div class="bulk-run"><button type="button" class="btn btn-accent" id="toChange">改善点をヒアリングで相談する →</button></div>`
          : '<div class="empty small"><p>「AIで評価する」を押すと、会話・設計・構築・テストを通して評価し、改善点を出します。</p></div>'}
      </section>`;

    const evalBtn = body.querySelector('#evalBtn');
    setRunState(evalBtn, !v ? '設計書を確定する' : !configuredProviders(loadSettings()).includes(project.provider) ? 'AIを設定する' : '');
    body.querySelector('#toChange')?.addEventListener('click', () => go('hearing'));
    evalBtn.addEventListener('click', async () => {
      const convo = project.messages.map(m => `${m.role === 'user' ? '利用者' : 'AI'}: ${m.content}`).join('\n').slice(-12000);
      const payload = {
        spec: v.spec,
        lint: issues,
        build: b ? b.items.map(i => ({ type: i.type, name: i.name, result: i.result, error: i.error })) : null,
        verify: project.lastVerify?.results || null,
        tests: cases.map(c => ({ title: c.title, expected: c.expected, status: c.status, memo: c.memo }))
      };
      const reply = await withAi(evalBtn, '評価中…', () => ask(evaluateSystem(), [{
        role: 'user', content: `# ヒアリングの会話\n${convo || '(なし)'}\n\n# 設計書・構築・テストの状況\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``
      }]));
      if (!reply || !alive) return;
      project.evaluations.push({ at: Date.now(), version: v.version, provider: project.provider, content: reply });
      await save();
      if (project.phase === 'evaluate') renderEvaluate(body);
    });
  }

  renderShell();
  return () => { alive = false; off(); };
}
