/* 画面共通の小さなヘルパー */

export function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

export function spinnerHtml(text = '処理中…') {
  return `<span class="spinner" aria-hidden="true"></span><span>${escapeHtml(text)}</span>`;
}

export function formatDateTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

let toastTimer = null;
export function toast(message, kind = 'info') {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.className = `toast toast-${kind} show`;
  el.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

/**
 * 確認ダイアログ。書き込み前に「何に対して何をするか」を名前つきで見せる。
 * requireText を渡すと、その文字列を入力するまで実行できない(取り返しのつかない操作用)。
 */
export function confirmDialog({ title, bodyHtml, okLabel = '実行する', danger = false, requireText = '' }) {
  return new Promise(resolve => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
        <h3 id="modalTitle">${escapeHtml(title)}</h3>
        <div class="modal-body">${bodyHtml}</div>
        ${requireText ? `<label class="field"><span>確認のため「${escapeHtml(requireText)}」と入力</span><input type="text" class="modal-require" autocomplete="off"></label>` : ''}
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" data-act="cancel">キャンセル</button>
          <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="ok">${escapeHtml(okLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    const ok = wrap.querySelector('[data-act="ok"]');
    const req = wrap.querySelector('.modal-require');
    if (req) {
      ok.disabled = true;
      req.addEventListener('input', () => { ok.disabled = req.value.trim() !== requireText; });
      req.focus();
    } else {
      ok.focus();
    }
    const close = v => { wrap.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = e => { if (e.key === 'Escape') close(false); };
    document.addEventListener('keydown', onKey);
    wrap.addEventListener('click', e => {
      if (e.target === wrap) close(false);
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'cancel') close(false);
      if (act === 'ok' && !ok.disabled) close(true);
    });
  });
}

/** 実行ボタンの有効/無効。押せない時は理由を横に出す(黙って灰色にしない) */
export function setRunState(btn, missing) {
  btn.disabled = !!missing;
  let hint = btn.parentElement?.querySelector('.run-hint');
  if (!hint && btn.parentElement) {
    hint = document.createElement('span');
    hint.className = 'run-hint';
    btn.after(hint);
  }
  if (hint) hint.textContent = missing ? `→ ${missing}` : '';
}

export function newId(prefix = 'id') {
  const rnd = crypto.getRandomValues(new Uint8Array(8));
  return `${prefix}_${Date.now().toString(36)}${Array.from(rnd, b => b.toString(16).padStart(2, '0')).join('')}`;
}

export function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** AIの返答(Markdown風)を安全に最低限整形する。HTMLはすべてエスケープしてから装飾する */
export function renderRichText(text) {
  const esc = escapeHtml(text);
  return esc
    .replace(/```(?:json)?\n?([\s\S]*?)```/g, (_, code) => `<pre class="code">${code}</pre>`)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
}
