# Genesys SDD Studio

話すだけで、Genesys Cloud のコンタクトセンター設定を **ヒアリング → 設計 → 構築 → テスト → 評価** まで進めるWebアプリです。
[genesys-ava-skills](https://github.com/purecloudlabs/genesys-ava-skills)(AVA = AIエージェントを、IDEの中で設計→構築→テスト→評価するSpec-Driven Development)の考え方を、AVA以外の設定にも広げ、IDEではなくブラウザのGUIで使えるようにしたものです。

## できること

| 工程 | 内容 |
|---|---|
| 💬 ヒアリング | 業務プロジェクト(「〇〇受付業務」など)ごとにAIと会話し、営業時間・分岐・窓口のイメージをすり合わせる。変更依頼もここで話しかける |
| 📐 設計 | 会話から **設計書(JSON)** を作る。機械的な検査(転送先キューが無い、時刻が逆転 等)と **着信シミュレーター**(日時と押す番号で流れを確認、組織に触らない)で確かめてから、版(v1, v2…)として確定。変更時は前の版との差分を表示 |
| 🛠 構築 | 確定した版を Genesys Cloud に構築(下の「スキル」)。先に組織を読んで計画を出し、確認してから実行。**他で作られた同名の設定は上書きしない**。このアプリが作ったフロー・AVA・コールルーティングだけは、変更時に新しい版として反映 |
| 🧪 テスト | 構築したものを組織から取り直して設計書どおりか検証。AIがテスト通話シナリオを作り、結果を記録。AVAはテスト版と実際に会話でき、AIがお客様役になる自動テスト → 本番公開まで |
| 📊 評価 | 会話・設計・構築・テストを通してAIが採点し、改善提案を出す → そのままヒアリングで変更を相談 |

- AIは **Claude / ChatGPT / Gemini** を併用でき、プロジェクトごとに切り替えられます。

## スキル(アプリが持つ専門知識と構築手順)

アプリの中に「スキル」を持たせ、利用者が契約しているAIはその知識を読んで**設計書を書くだけ**にしています。組織への書き込みは常にアプリの決まった手順(計画 → 名前つき確認 → 実行 → 取り直して検証)で行うため、AIが勝手に組織を変えることはありません(`js/sdd/skills.js`)。

| スキル | 自動で作るもの | 使うAPI |
|---|---|---|
| ルーティング | ACDスキル・後処理コード・キュー | `/api/v2/routing/{skills,wrapupcodes,queues}` |
| 営業時間 | スケジュール・スケジュールグループ | `/api/v2/architect/{schedules,schedulegroups}` |
| 着信フロー(IVR) | 営業時間内・時間外・休業日の着信フローを作成・公開 | `POST /api/v2/flows/jobs`(ArchitectフローYAMLの取り込み) |
| 電話番号 | 登録済みの番号を着信フロー・スケジュールグループに割り当て | `/api/v2/architect/ivrs`、番号確認 `/api/v2/telephony/providers/edges/dids` |
| エージェント | 既存ユーザー(メールで指定)へのスキル付与・キュー所属 | `/api/v2/users/search`、`/users/{id}/routingskills`、`/routing/queues/{id}/members` |
| データテーブル | テーブル作成と初期データ | `/api/v2/flows/datatables` |
| ボットフロー | 意図(インテント)と言い方を持つボットフローを作成・公開 | `POST /api/v2/flows/jobs` |
| AVA | AVA作成 → 版の作成(事前にサーバー検証)→ テスト公開 → 会話テスト → 本番公開 | `/api/v2/agentic/virtualagents/**` |

AVAは Genesys 公式の [genesys-ava-skills](https://github.com/purecloudlabs/genesys-ava-skills)(MIT)を参考にしています。版の定義の形・API呼び出しは公式の `ava-mcp` が実際に送っているものと公開API仕様に合わせ、公式のクイックガイドを `knowledge/genesys-ava-skills/`(MITライセンス表記つき)に同梱して、AVAの話が出た時にAIへ知識として渡します。フローのYAMLは、Genesys公式のArchyサンプルで確認できた構文だけを使っています(`js/sdd/flowYaml.js`)。

**手作業になるもの**(公開APIが無い・組織全体の設定・確認できていないもの):組織設定(ディビジョン・ロール・OAuth・外部連携の認証情報)/電話番号の購入・DIDプール・回線/ユーザー(アカウント)の作成/入口のフローからボット・AVAを呼び出す設定。

### 「個人で契約しているAI」について
このアプリが使うのは各社の **APIキー**(従量課金)です。Claude Pro / ChatGPT Plus などのチャット用サブスクリプションは、外部のアプリから使えない仕組みになっています(各社の規約・仕様)。APIキーは各社の開発者向け画面(Anthropic Console / OpenAI Platform / Google AI Studio)で発行します。

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
2. Genesys Cloud 管理者が「管理 → OAuth」で **Code Authorization(PKCE)** のクライアントを作り、Authorized redirect URI にアプリのURLを登録(スコープ例: `routing` `architect` `users` `telephony:readonly` `agentic-virtualagents`。ログインする人のロールにも同じ権限が必要)。
3. アプリの「設定」で、使うAIのAPIキーと、Genesysのリージョン・クライアントIDを入れて接続。
4. 「＋ 新しい業務プロジェクト」から始める。

## 構成

```
index.html / app.js / style.css   画面の枠・ルーティング・オレンジ基調のデザイン
js/core/   genesysAuth(OAuth PKCE) / gcApi(Platform APIラッパー) / ai(Claude・OpenAI・Gemini) / store(IndexedDB) / ui
js/sdd/    spec(設計書の形・検査・差分・シミュレーター) / skills(スキル一覧とAIへの知識) / prompts(工程ごとのAI指示)
           builder(計画・構築・検証) / flowYaml(着信フロー・ボットフローのYAML) / ava(AVAの定義・公開・会話テスト)
knowledge/ AIに渡す公式ナレッジ(genesys-ava-skills のクイックガイド, MIT)
js/views/  home / project(5工程) / settings
tests/     Playwright + APIモック
```

テスト: `NODE_PATH=/opt/node22/lib/node_modules node tests/run-all.js`

## 既知の制約・要実機確認

実組織に対しては、まずテスト用の組織で次を確認してから本番利用してください(公式仕様・公式サンプルに基づいて実装していますが、実機では未確認です)。

- スケジュールのペイロード(休業日を「当日0時〜翌日0時」で作る形、営業時間を2024-01-01週起点の毎週繰り返しで作る形)。
- フローの取り込み(`/api/v2/flows/jobs`):署名付きURLへのブラウザからのアップロードが通るか(CORS)、ジョブが公開まで行うか(行わない場合は公開APIで公開する実装あり)、同名フローへの再取り込みが新しい版になるか、日本語(`ja-jp`)のTTS・ボットのNLU(`ja`)。
- データテーブルのスキーマ形式(キー列を `key`、他の列を列名で持つ形)と行の登録形式。
- AVAの会話テストAPI(`/agentic/virtualagents/{id}/sessions`)は公式 `ava-mcp` が使っているものですが、公開API仕様書(swagger)には載っていません。日本語(`ja-jp`)対応も要確認。
- 他で作られた既存設定の更新・削除はしません(同名があれば「既存」として触らない)。設計書から外したものは組織に残ります(削除はしません)。
- APIキーをブラウザに置くため、共有PCでは使い終わったら設定画面で削除してください。
