/* 工程の定義(順番がそのまま画面のステッパーになる) */
export const PHASES = [
  { id: 'hearing', label: 'ヒアリング', icon: '💬', desc: 'AIと会話して、業務のイメージをすり合わせます。変更したい時もここで話しかけます。' },
  { id: 'design', label: '設計', icon: '📐', desc: '会話から設計書を作り、検査とシミュレーターで確認してから版として確定します。' },
  { id: 'build', label: '構築', icon: '🛠', desc: '確定した設計書をGenesys Cloudに構築します。既存の設定は上書きしません。' },
  { id: 'test', label: 'テスト', icon: '🧪', desc: '構築結果を組織から取り直して検証し、テスト通話のシナリオを消化します。' },
  { id: 'evaluate', label: '評価', icon: '📊', desc: '要件・設計・構築・テストを通してAIが評価し、次の改善点を出します。' }
];
