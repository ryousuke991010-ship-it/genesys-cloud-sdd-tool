/* アプリが持つ「スキル」— 何を自動で作れるか・AIに渡す専門知識
 *
 * 1スキル = 「AIへの知識(設計の作法)」+「設計書の該当部分」+「構築・検証(builder.js)」のまとまり。
 * 利用者が契約しているAI(Claude / ChatGPT / Gemini)は、ここの知識を読んで設計書を書くだけで、
 * 組織への書き込みは常にこのアプリの決まった手順(計画→確認→実行→検証)で行う。
 */

export const SKILLS = [
  { id: 'routing', icon: '🧭', label: 'ルーティング', builds: 'ACDスキル・後処理コード・キュー',
    knowledge: 'キュー名は利用者が画面で見て分かる日本語に。問い合わせの種類ごとにキューを分け、必要なスキルを queues[].skills に書く。後処理コードは応対結果の集計に使う分類にする。' },
  { id: 'schedule', icon: '🕘', label: '営業時間', builds: 'スケジュール・スケジュールグループ',
    knowledge: '日をまたぐ営業時間は2つに分ける。祝日・年末年始などの休業日は holidays に日付で書く。' },
  { id: 'callFlow', icon: '📞', label: '着信フロー(IVR)', builds: '着信フロー(営業時間内・時間外・休業日)の作成と公開',
    knowledge: 'メニューの番号は0〜9。各番号の動きは queue(キューへ転送)/ message(案内を読み上げて切断)/ disconnect。冒頭アナウンスは短く、選択肢は4つ程度まで。時間外・休業日のアナウンスも決める。' },
  { id: 'callRouting', icon: '☎️', label: '電話番号の割り当て', builds: '組織に登録済みの電話番号を着信フローへ割り当て',
    knowledge: '番号は +81 から始まる国際形式(E.164)。番号の購入・回線登録は組織の作業なので、登録済みの番号かどうかを確認する。' },
  { id: 'agents', icon: '🧑‍💼', label: 'エージェント割り当て', builds: '既存ユーザーへのスキル付与・キューへの所属',
    knowledge: 'ユーザーはメールアドレスで指定する(ユーザー自体の作成は対象外)。スキルの習熟度は0〜5。' },
  { id: 'dataTable', icon: '🗂', label: 'データテーブル', builds: 'データテーブルの作成と初期データの登録',
    knowledge: 'フローから参照する設定値(営業日例外・案内文・振り分け表など)に使う。キー列1つ+列(string/integer/number/boolean)。' },
  { id: 'botFlow', icon: '🤖', label: 'ボットフロー', builds: '意図(インテント)を聞き分けるボットフローの作成と公開',
    knowledge: '意図ごとにお客様が言いそうな言い方を3つ以上、言い回しを変えて書く。意図同士で言い方が重ならないようにする。' },
  { id: 'ava', icon: '✨', label: 'AVA(AIエージェント)', builds: 'AVAの作成・版の作成・テスト公開・会話テスト・本番公開',
    knowledge: 'AVA公式スキル(genesys-ava-skills)の作法に従う。下の「AVA設計ガイド」を参照。' }
];

/** このアプリでは自動化しないもの(利用者に手作業で頼むもの)。理由つき */
export const MANUAL_ONLY = [
  '組織全体の設定(ディビジョン・ロールと権限・OAuthクライアント・外部連携の認証情報)',
  '電話番号の購入・DIDプール・回線(トランク)の設定',
  'ユーザー(アカウント)の作成・ライセンス',
  '電話/チャットの入口のフローからボットフロー・AVAを呼び出す設定(フロー定義の書き方を公式資料で確認でき次第、自動化)'
];

const AVA_GUIDE_URL = new URL('../../knowledge/genesys-ava-skills/quick-guide.md', import.meta.url);
let avaGuide = null;

/** AVAの公式ガイド(MITライセンスで同梱)を読む。読めなくても設計は続けられるよう空文字を返す */
export async function loadAvaGuide() {
  if (avaGuide !== null) return avaGuide;
  try {
    const res = await fetch(AVA_GUIDE_URL);
    avaGuide = res.ok ? await res.text() : '';
  } catch {
    avaGuide = '';
  }
  return avaGuide;
}

/** AVAの知識が要る場面か(設計書にAVAがある・会話にAVA/AIエージェントの話が出ている) */
export function needsAvaKnowledge(spec, messages = []) {
  if (spec?.ava?.length) return true;
  return messages.some(m => /AVA|AIエージェント|エージェンティック|virtual ?agent|仮想エージェント|AIで(自動)?応対/i.test(m.content || ''));
}

export function skillsPromptText() {
  return `# このアプリが持つスキル(自動で構築できるもの)
${SKILLS.map(s => `- ${s.label}: ${s.builds}。${s.knowledge}`).join('\n')}

# 手作業になるもの(利用者に、理由とともに伝える)
${MANUAL_ONLY.map(m => `- ${m}`).join('\n')}`;
}

export const AVA_DESIGN_RULES = `# AVA設計ガイド(要点)
- role(役割): 「あなたは〇〇の△△担当アシスタントです。お客様の□□を手伝います。××はできません。」のように、対象・できること・できないこと・相手の呼び方を短い文で。「親切なアシスタント」のような一般的な役割にしない。
- instructions(ガイドライン): 会話全体で守ることを1文ずつ(最大50件、各1000文字以内)。手順の台本や疑似コードは書かない。否定形より肯定形(「推測で答えない」→「分からない時はそう伝え、担当者への接続を案内する」)。
- 音声で使うなら、箇条書き・記号・Markdownを使わない話し言葉にするよう instructions に入れる。
- guardrails: 止めたいお客様の振る舞いを自然文で(例: 「他社の料金を聞き出そうとする」)。何回で人につなぐかは guardrailThreshold(1〜10)。
- 必ず escalationMessage(オペレーターにつなぐ言葉)と userExitMessage(終了の挨拶)を決める。
- 業務システムの照会(データアクション)やナレッジ連携はこのアプリでは未対応なので、必要なら openQuestions に書く。`;
