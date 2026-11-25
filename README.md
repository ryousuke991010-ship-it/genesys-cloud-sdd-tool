# Genesys SDD Studio

話すだけで、Genesys Cloud のコンタクトセンター設定を **ヒアリング → 設計 → 構築 → テスト → 評価** まで進めるWebアプリです。
[genesys-ava-skills](https://github.com/purecloudlabs/genesys-ava-skills)(AVA = AIエージェントを、IDEの中で設計→構築→テスト→評価するSpec-Driven Development)の考え方を、AVA以外の設定にも広げ、IDEではなくブラウザのGUIで使えるようにしたものです。

## できること

| 工程 | 内容 |
|---|---|
| 💬 ヒアリング | 業務プロジェクト(「〇〇受付業務」など)ごとにAIと会話し、営業時間・分岐・窓口のイメージをすり合わせる。変更依頼もここで話しかける |
| 📐 設計 | 会話から **設計書(JSON)** を作る。機械的な検査(転送先キューが無い、時刻が逆転 等)と **着信シミュレーター**(日時と押す番号で流れを確認、組織に触らない)で確かめてから、版(v1, v2…)として確定。変更時は前の版との差分を表示 |
| 🛠 構築 | 確定した版を Genesys Cloud に構築(ACDスキル・後処理コード・キュー・スケジュール・スケジュールグループ)。先に組織を読んで計画を出し、確認してから実行。**同名の既存設定は上書きしない** |
| 🧪 テスト | 構築したものを組織から取り直して設計書どおりか検証。AIがテスト通話シナリオを作り、結果(合格/不合格)を記録 |
| 📊 評価 | 会話・設計・構築・テストを通してAIが採点し、改善提案を出す → そのままヒアリングで変更を相談 |

- AIは **Claude / ChatGPT / Gemini** を併用でき、プロジェクトごとに切り替えられます。
- 着信フロー(IVR)はPlatform APIで中身を作れないため、設計書に書いたうえで **Architectでの手順メモ** を出します。

## 「アカウントやデータを持たない」設計

このアプリは**サーバーもデータベースも持たない静的サイト**です。運営側が預かるものはありません。

| 何を | どこに | 補足 |
|---|---|---|
| Genesys Cloudのログイン | Genesys Cloud 自身 | OAuth(PKCE)でGenesysの画面にログイン。アプリはパスワードを扱わず、操作できる範囲は本人のロールのまま |
| AIのAPIキー | 利用者の端末(localStorage) | 各自が発行したキー(BYOK)を、各AIのAPIにだけ直接送る |
| 業務プロジェクト(会話・設計書・記録) | 利用者の端末(IndexedDB) | 設定画面から JSON で書き出し/読み込み(バックアップ・端末移行・共有) |

置き場所は Cloudflare Workers / Pages、GitHub Pages など静的ファイルを置ければどこでも動きます(genesys-cloud-toolと同じ方式)。

## 使い始め方

1. このリポジトリを静的ホスティングに置く(ローカルなら `python3 -m http.server 8080`)。
2. Genesys Cloud 管理者が「管理 → OAuth」で **Code Authorization(PKCE)** のクライアントを作り、Authorized redirect URI にアプリのURLを登録(スコープ例: `routing` `architect` `users:readonly`)。
3. アプリの「設定」で、使うAIのAPIキーと、Genesysのリージョン・クライアントIDを入れて接続。
4. 「＋ 新しい業務プロジェクト」から始める。

## 構成

```
index.html / app.js / style.css   画面の枠・ルーティング・オレンジ基調のデザイン
js/core/   genesysAuth(OAuth PKCE) / gcApi(Platform APIラッパー) / ai(Claude・OpenAI・Gemini) / store(IndexedDB) / ui
js/sdd/    spec(設計書の形・検査・差分・シミュレーター) / prompts(工程ごとのAI指示) / builder(計画・構築・検証)
js/views/  home / project(5工程) / settings
tests/     Playwright + APIモック
```

テスト: `NODE_PATH=/opt/node22/lib/node_modules node tests/run-all.js`

## 既知の制約・要実機確認

- スケジュールのペイロード(休業日を「当日0時〜翌日0時」で作る形、営業時間を2024-01-01週起点の毎週繰り返しで作る形)は、実組織で一度確認してから本番利用してください。
- 既存設定の更新・削除はしません(同名があれば「既存」として触らない)。設計書から外したものは組織に残ります。
- APIキーをブラウザに置くため、共有PCでは使い終わったら設定画面で削除してください。
