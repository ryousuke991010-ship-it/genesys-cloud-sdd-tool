/* 複数AIへの接続 — ブラウザから各社APIを直接呼ぶ(自前サーバーを経由しない)
 *
 * キーは利用者が自分で発行したもの(BYOK)。この端末のlocalStorageにだけ保存し、
 * 各社のAPIにだけ送る。プロジェクトごとに使うAIを選べる。
 */

export const PROVIDERS = {
  anthropic: {
    label: 'Claude (Anthropic)',
    keyHint: 'sk-ant-…',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    defaultModel: 'claude-opus-5-5',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2']
  },
  openai: {
    label: 'ChatGPT (OpenAI)',
    keyHint: 'sk-…',
    keyUrl: 'https://platform.openai.com/api-keys',
    defaultModel: 'gpt-5',
    models: []
  },
  gemini: {
    label: 'Gemini (Google)',
    keyHint: 'AIza…',
    keyUrl: 'https://aistudio.google.com/apikey',
    defaultModel: 'gemini-2.5-pro',
    models: []
  }
};

export function configuredProviders(settings) {
  return Object.keys(PROVIDERS).filter(id => settings?.ai?.[id]?.apiKey);
}

export function modelFor(settings, providerId) {
  return settings?.ai?.[providerId]?.model || PROVIDERS[providerId]?.defaultModel || '';
}

const TIMEOUT_MS = 180 * 1000;

async function postJson(url, headers, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: controller.signal });
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('AIの応答が3分以内に返りませんでした。内容を短くするか、もう一度お試しください。');
      throw new Error(`AIのAPIに接続できませんでした: ${e.message}`);
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = data?.error?.message || data?.message || `HTTP ${res.status}`;
      if (res.status === 401 || res.status === 403) throw new Error(`AIのAPIキーが受け付けられませんでした(${msg})。設定画面でキーを確認してください。`);
      if (res.status === 429) throw new Error(`AIの利用上限に達しました(${msg})。少し待つか、別のAIに切り替えてください。`);
      throw new Error(`AIのAPIエラー: ${msg}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * system: システムプロンプト / messages: [{role:'user'|'assistant', content:string}]
 * 戻り値: 返答テキスト
 */
export async function chat({ settings, provider, system, messages }) {
  const conf = settings?.ai?.[provider];
  if (!conf?.apiKey) throw new Error(`${PROVIDERS[provider]?.label || provider} のAPIキーが未設定です。設定画面で登録してください。`);
  const model = modelFor(settings, provider);

  if (provider === 'anthropic') {
    const data = await postJson('https://api.anthropic.com/v1/messages', {
      'x-api-key': conf.apiKey,
      'anthropic-version': '2026-10-21',
      // 自前サーバーを持たない設計なので、ブラウザから直接呼ぶことを明示する
      'anthropic-dangerous-direct-browser-access': 'true',
      // 安全分類で断られた時に、サーバー側で自動的に別モデルへ切り替える
      'anthropic-beta': 'server-side-fallback-2026-07-01'
    }, {
      model,
      max_tokens: 16000,
      system,
      messages,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      fallbacks: 'default'
    });
    if (data?.stop_reason === 'refusal') throw new Error('AIがこの依頼への回答を控えました。言い回しを変えてもう一度お試しください。');
    const text = (data?.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    if (!text) throw new Error('AIから本文のない応答が返りました。もう一度お試しください。');
    return text;
  }

  if (provider === 'openai') {
    const data = await postJson('https://api.openai.com/v1/chat/completions', {
      Authorization: `Bearer ${conf.apiKey}`
    }, {
      model,
      messages: [{ role: 'system', content: system }, ...messages]
    });
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('AIから本文のない応答が返りました。もう一度お試しください。');
    return text;
  }

  if (provider === 'gemini') {
    const data = await postJson(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      { 'x-goog-api-key': conf.apiKey },
      {
        systemInstruction: { parts: [{ text: system }] },
        contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }))
      }
    );
    const text = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
    if (!text) throw new Error('AIから本文のない応答が返りました(安全フィルタの可能性)。言い回しを変えてお試しください。');
    return text;
  }

  throw new Error(`未対応のAIです: ${provider}`);
}

/** 返答の中から最初の```json ... ```ブロック(無ければ最初の{...})を取り出してparseする */
export function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    throw new Error('AIの返答から設計データ(JSON)を読み取れませんでした。もう一度「設計書を作成」を押してください。');
  }
}
