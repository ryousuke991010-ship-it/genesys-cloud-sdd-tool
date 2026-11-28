/* 設計書 → Architectフロー定義(Archy形式のYAML)
 *
 * POST /api/v2/flows/jobs で受け付けられる「ArchitectフローのYAML」を組み立てる。
 * 使う構文は、Genesys公式のArchyサンプル(developer.genesys.cloud の Archy Example Flows / Flow Authoring)
 * で確認できたものだけに限る:
 *   inboundCall: name / description / defaultLanguage / startUpRef / initialGreeting.tts / menus / tasks
 *   menu: name / refId / audio.tts / choices(menuTransferToAcd・menuJumpToTask・menuDisconnect)
 *   task actions: playAudio(audio.tts)・transferToAcd(targetQueue.lit.name)・disconnect
 *   botFlow: settingsErrorHandling / settingsUserInput / bots / askForIntent / exitBotFlow / settingsNaturalLanguageUnderstanding
 * これ以外(スケジュール評価・ボット呼び出し等)はフロー内で使わない。営業時間の分岐は
 * コールルーティング(/api/v2/architect/ivrs)の通常時/時間外/休日フローで行う。
 */

/** このアプリが作ったことを示す印。同名のフローでも、これが無いものは更新しない */
export const MANAGED_MARK = '[Genesys SDD Studio]';

/* ---------- 最小のYAML出力(文字列は常にJSON形式の二重引用符でクォートする=有効なYAML) ---------- */
function scalar(v) {
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (v && typeof v === 'object' && v.__raw) return v.__raw;
  return JSON.stringify(String(v ?? ''));
}
const raw = v => ({ __raw: v });

export function toYaml(value, indent = 0) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return `${pad}[]\n`;
    return value.map(item => {
      if (item && typeof item === 'object' && !item.__raw) {
        const inner = toYaml(item, indent + 2);
        return `${pad}- ${inner.slice(indent + 2)}`;
      }
      return `${pad}- ${scalar(item)}\n`;
    }).join('');
  }
  if (value && typeof value === 'object' && !value.__raw) {
    return Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => {
      if (v && typeof v === 'object' && !v.__raw) {
        if (Array.isArray(v) && !v.length) return `${pad}${k}: []\n`;
        return `${pad}${k}:\n${toYaml(v, indent + 2)}`;
      }
      return `${pad}${k}: ${scalar(v)}\n`;
    }).join('');
  }
  return `${pad}${scalar(value)}\n`;
}

/* ---------- 着信フロー ---------- */
export const callFlowName = (spec, kind) => `${spec.business.name}_着信_${{ open: '営業時間内', closed: '時間外', holiday: '休業日' }[kind]}`;
export const callRoutingName = spec => `${spec.business.name}_コールルーティング`;

const lang = 'ja-jp';
const ref = id => raw(`/inboundCall/tasks/task[${id}]`);
const queueRef = name => ({ lit: { name } });

function finalActions(a, label) {
  if (!a || a.action === 'disconnect') return [{ disconnect: { name: '切断' } }];
  if (a.action === 'queue') return [{ transferToAcd: { name: `${label}: ${a.target}へ転送`, targetQueue: queueRef(a.target) } }];
  return [{ playAudio: { name: `${label}: 案内`, audio: { tts: a.target } } }, { disconnect: { name: '切断' } }];
}

/** 0〜9のメニューだけを作る(*・#は検査で注意を出し、ここでは作らない) */
export const buildableMenu = spec => spec.ivr.menu.filter(m => /^[0-9]$/.test(m.digit));

export function menuPrompt(spec) {
  return buildableMenu(spec).map(m => `${m.label}は${m.digit}を`).join('、') + (buildableMenu(spec).length ? '押してください。' : '');
}

/** kind: open(営業時間内) / closed(時間外) / holiday(休業日) */
export function callFlowYaml(spec, kind) {
  const name = callFlowName(spec, kind);
  const flow = {
    name,
    description: `${MANAGED_MARK} ${spec.business.name} の${{ open: '営業時間内', closed: '時間外', holiday: '休業日' }[kind]}の着信フロー`,
    defaultLanguage: lang
  };
  if (kind !== 'open') {
    const msg = kind === 'closed' ? spec.ivr.afterHoursMessage : spec.ivr.holidayMessage;
    flow.startUpRef = ref('main');
    flow.tasks = [{ task: { name: 'アナウンスして切断', refId: 'main', actions: finalActions({ action: 'message', target: msg || '本日の受付は終了しました。' }, kind === 'closed' ? '時間外' : '休業日') } }];
    return toYaml({ inboundCall: flow });
  }
  if (spec.ivr.greeting) flow.initialGreeting = { tts: spec.ivr.greeting };
  const menu = buildableMenu(spec);
  if (!menu.length) {
    flow.startUpRef = ref('main');
    flow.tasks = [{ task: { name: '受付', refId: 'main', actions: finalActions(spec.ivr.noInput, '受付') } }];
    return toYaml({ inboundCall: flow });
  }
  const tasks = [];
  const choices = menu.map(m => {
    const dtmf = `digit_${m.digit}`;
    if (m.action === 'queue') {
      return { menuTransferToAcd: { name: `${m.digit}: ${m.label}`, dtmf, targetQueue: queueRef(m.target) } };
    }
    if (m.action === 'message') {
      const id = `menu_${m.digit}`;
      tasks.push({ task: { name: `${m.digit}: ${m.label}`, refId: id, actions: finalActions(m, m.label) } });
      return { menuJumpToTask: { name: `${m.digit}: ${m.label}`, dtmf, targetTaskRef: ref(id) } };
    }
    return { menuDisconnect: { name: `${m.digit}: ${m.label}`, dtmf } };
  });
  flow.startUpRef = raw('/inboundCall/menus/menu[mainMenu]');
  flow.menus = [{ menu: { name: 'メインメニュー', refId: 'mainMenu', audio: { tts: menuPrompt(spec) }, choices } }];
  if (tasks.length) flow.tasks = tasks;
  return toYaml({ inboundCall: flow });
}

/** 設計書から作るべき着信フロー(kindの配列) */
export function callFlowKinds(spec) {
  const hasIvr = spec.ivr.greeting || spec.ivr.menu.length || spec.ivr.noInput;
  if (!hasIvr) return [];
  const kinds = ['open'];
  if (spec.hours.length) kinds.push('closed');
  if (spec.holidays.length) kinds.push('holiday');
  return kinds;
}

/* ---------- ボットフロー(意図の聞き分け) ---------- */
const comm = text => ({ exp: `MakeCommunication(${JSON.stringify(text)})` });

export function botFlowYaml(bot) {
  const flow = {
    name: bot.name,
    description: `${MANAGED_MARK} 意図の聞き分けボット`,
    startUpRef: raw('/botFlow/bots/bot[mainBot]'),
    defaultLanguage: lang,
    settingsErrorHandling: {
      errorHandling: { exit: { none: true } },
      errorEventHandover: comm('申し訳ありません、エラーが発生しました。担当者におつなぎします。'),
      agentEscalationConfirmation: comm('担当者との会話をご希望ですか？'),
      agentEscalationHandover: comm('担当者におつなぎします。少々お待ちください。'),
      recognitionFailureEventHandover: comm('うまく聞き取れませんでした。担当者におつなぎします。'),
      recognitionFailureEventHandling: { exit: { none: true } }
    },
    settingsBotFlow: { none: true },
    settingsUserInput: {
      noMatchesMax: { lit: 3 },
      noInputsMax: { lit: 3 },
      noInputsTimeout: { lit: { seconds: 7 } },
      confirmationRejectionsMax: { lit: 3 },
      collectionLowConfidenceThreshold: { lit: 20 },
      collectionHighConfidenceThreshold: { lit: 70 },
      confirmationLowConfidenceThreshold: { lit: 40 },
      noMatchApology: comm('申し訳ありません。'),
      noInputApology: comm('申し訳ありません、聞き取れませんでした。'),
      noToConfirmationApology: comm('失礼しました。'),
      confirmationNoMatchApology: comm('「はい」か「いいえ」でお答えください。'),
      confirmationNoInputApology: comm('聞き取れませんでした。「はい」か「いいえ」でお答えください。')
    },
    bots: [{
      bot: {
        name: 'メイン',
        refId: 'mainBot',
        actions: [
          {
            askForIntent: {
              name: '用件を聞く',
              question: comm(bot.question || 'ご用件をお話しください。'),
              noInput: comm(bot.noMatch || 'ご用件を短くお話しください。'),
              noMatch: comm(bot.noMatch || 'もう一度ご用件をお話しください。'),
              outputs: {
                intents: bot.intents.map(i => ({ intent: { name: i.name, actions: [{ exitBotFlow: { name: `${i.name}で終了` } }], enabled: true } }))
              }
            }
          },
          { exitBotFlow: { name: '終了' } }
        ]
      }
    }],
    settingsNaturalLanguageUnderstanding: {
      nluDomainVersion: {
        intents: bot.intents.map(i => ({ name: i.name, utterances: i.utterances.map(u => ({ segments: [{ text: u }] })) })),
        language: 'ja'
      }
    }
  };
  return toYaml({ botFlow: flow });
}
