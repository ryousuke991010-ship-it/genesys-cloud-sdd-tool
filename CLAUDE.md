# CLAUDE.md — genesys-cloud-sdd-tool 開発ルール

## これは何か
話すだけで Genesys Cloud の設定を「ヒアリング → 設計 → 構築 → テスト → 評価」まで進めるWebアプリ(README参照)。
UIの作法は `genesys-cloud-tool` を参考にしているが、別アプリ。

## 原則
- **サーバー・DBを持たない**。ログインはGenesys(OAuth PKCE)、AIキーは利用者の端末、プロジェクトはIndexedDB。運営側にデータを持たせる変更をしない。
- ビルドツール・フレームワーク・CDNを増やさない(素のHTML/CSS/ESモジュール)。
- **設計書(`js/sdd/spec.js`)が唯一の基準**。構築・テスト・評価は確定した版の設計書から行い、会話や画面の状態から直接組織を書き換えない。
- Genesys Cloud API は `js/core/gcApi.js`、AI は `js/core/ai.js` を必ず経由する。
- 組織への書き込みは「計画(読むだけ)→ 名前つきの確認ダイアログ → 実行 → 取り直して検証」の順。**既存設定は上書き・削除しない**。
- 実在を確認していないAPIエンドポイント・レスポンス形状を想像で使わない。新しく使う時はREADMEの「要実機確認」に書く。
- AIの返答・利用者入力を画面に出す時は必ず `escapeHtml`/`renderRichText` を通す。
- 色は `style.css` 冒頭のトークン(オレンジ基調)だけを使う。

## テスト
push前に `NODE_PATH=/opt/node22/lib/node_modules node tests/run-all.js` を全件通す。
Genesys・各AIのAPIは `page.route()` でモックする(`tests/helpers.js`)。新しい工程・書き込み処理には専用のspecを追加する。
