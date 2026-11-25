/* 画面間で共有する小さな状態(循環importを避けるため app.js から分離) */

let busy = false;
/** AIの応答待ち・構築中など、画面を離れてほしくない間だけ true にする */
export function setBusy(v) { busy = !!v; }
export function isBusy() { return busy; }

export function navigate(hash) {
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = hash;
}

/** サイドバーのプロジェクト一覧を描き直す(app.jsが登録する) */
export const hooks = { refreshNav: async () => {} };
