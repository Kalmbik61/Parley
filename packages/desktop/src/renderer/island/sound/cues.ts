/**
 * Политика сигналов острова (#9 §3.5, §6.4): чистая функция от времени и истории. Она решает, звучит ли сигнал, когда
 * и как громко; сам звук играет движок (`synth.ts`, `graph.ts`), подписку ведёт `useIslandCues`. Отсюда нет импорта
 * движка: политика проверяется на поддельных часах без Web Audio.
 */

/** Сигналы острова (#9 §3.1). Согласие и терминал звучат `permission`, предложение комнаты — `question`. */
export type IslandSignal =
  | 'permission'
  | 'question'
  | 'plan'
  | 'done'
  | 'error'
  | 'start'
  | 'hover'
  | 'open'
  | 'close'
  | 'listen-start'
  | 'listen-end'
  | 'speak'
  | 'decide'
  | 'unmute';

/**
 * Приоритет (#9 §3.5 п. 5): ошибка > запросы > Done > начало работы, фазы помощника и `decide` > остров > микро.
 * Он решает приглушение под речь и порядок в одной пачке; более важный сигнал не ждёт менее важного.
 */
export const CUE_PRIORITY: Readonly<Record<IslandSignal, number>> = {
  error: 5,
  permission: 4,
  question: 4,
  plan: 4,
  done: 3,
  start: 2,
  'listen-start': 2,
  'listen-end': 2,
  speak: 2,
  decide: 2,
  open: 1,
  close: 1,
  hover: 0,
  unmute: 0,
};

/** Остывание по виду, мс (#9 §3.5 п. 2). Сигнал во время остывания не звучит, а сливается с прошлым. */
export const CUE_COOLDOWN_MS: Readonly<Partial<Record<IslandSignal, number>>> = {
  done: 2_000,
  permission: 1_200,
  question: 1_200,
  plan: 1_200,
  error: 2_000,
  start: 3_000,
  hover: 600,
};

/** Соседние сигналы не ближе этого, мс (#9 §3.5 п. 3). */
export const CUE_GAP_MS = 90;
/** Дольше этого сигнал очередь не ждёт и не звучит, мс. */
export const CUE_MAX_WAIT_MS = 400;
/** Бюджет Done: не больше `DONE_BUDGET` звуков за `DONE_BUDGET_MS` (#9 §3.5 п. 4). Запросы и ошибки им не ограничены. */
export const DONE_BUDGET = 3;
export const DONE_BUDGET_MS = 10_000;
/** Под речью работа и итог тише на столько, дБ (#9 §6.4). */
export const SPEECH_CUE_GAIN_DB = -10;
/**
 * Сколько последних ключей помнит политика. Окно острова живёт сутками; повторы ключа (переподключение, ререндер)
 * приходят вскоре после первого показа, поэтому старые ключи можно забыть.
 */
export const CUE_KEY_MEMORY = 1_000;

/** Под речью молчат сигналы с приоритетом не выше этого (микро и остров). */
const SPEECH_SILENT_MAX = 1;
/** Под речью с этого приоритета сигнал идёт в полную силу и приглушает голос (внимание). */
const SPEECH_ATTENTION_MIN = 4;

export interface CueRequest {
  signal: IslandSignal;
  /** `IslandPresentationOutcome.key` или свой ключ сигнала; повтор ключа молчит (#9 §3.5 п. 1). */
  key: string;
  /** Решение проводки по настройкам и `soundEligible`/`expand`: `false` — сигнал молчит, но ключ занят. */
  eligible: boolean;
}

export type CueDecision =
  | {
      verdict: 'play';
      /** Через сколько мс играть: зазор от уже запланированных сигналов. */
      delayMs: number;
      /** Поправка к уровню рецепта, дБ: 0 или `SPEECH_CUE_GAIN_DB`. */
      gainDb: number;
      /** Сигнал внимания под речью: голос опускается до 30 % на 0,7 с (`duckVoice` графа). */
      duckVoice: boolean;
    }
  /** Остывание: сигнал слит с прошлым; `merged` — сколько слито с последнего звука этого вида. */
  | { verdict: 'merge'; merged: number }
  | { verdict: 'skip'; reason: 'repeat' | 'ineligible' | 'speech' | 'budget' | 'busy' };

export interface CueHistory {
  /** Ключи, которые уже были, от старых к новым. */
  readonly keys: readonly string[];
  /** Время последнего звука по виду. */
  readonly lastPlayed: Readonly<Partial<Record<IslandSignal, number>>>;
  /** Сколько слито с последнего звука по виду. */
  readonly merged: Readonly<Partial<Record<IslandSignal, number>>>;
  /** Времена звуков Done в окне бюджета. */
  readonly doneTimes: readonly number[];
  /** Запланированные звуки, которые ещё держат зазор. */
  readonly slots: readonly { readonly at: number; readonly priority: number }[];
}

export const EMPTY_CUE_HISTORY: CueHistory = Object.freeze({
  keys: Object.freeze([]),
  lastPlayed: Object.freeze({}),
  merged: Object.freeze({}),
  doneTimes: Object.freeze([]),
  slots: Object.freeze([]),
});

function decideOne(history: CueHistory, request: CueRequest, now: number, speaking: boolean): { history: CueHistory; decision: CueDecision } {
  const { signal, key } = request;
  if (history.keys.includes(key)) return { history, decision: { verdict: 'skip', reason: 'repeat' } };
  const seen: CueHistory = { ...history, keys: [...history.keys, key].slice(-CUE_KEY_MEMORY) };
  const skip = (reason: 'ineligible' | 'speech' | 'budget' | 'busy') => ({ history: seen, decision: { verdict: 'skip', reason } as const });

  if (!request.eligible) return skip('ineligible');
  const priority = CUE_PRIORITY[signal];
  if (speaking && priority <= SPEECH_SILENT_MAX) return skip('speech');

  const cooldown = CUE_COOLDOWN_MS[signal];
  const last = seen.lastPlayed[signal];
  if (cooldown !== undefined && last !== undefined && now - last < cooldown) {
    const merged = (seen.merged[signal] ?? 0) + 1;
    return { history: { ...seen, merged: { ...seen.merged, [signal]: merged } }, decision: { verdict: 'merge', merged } };
  }

  const doneTimes = seen.doneTimes.filter((at) => now - at < DONE_BUDGET_MS);
  if (signal === 'done' && doneTimes.length >= DONE_BUDGET) return skip('budget');

  // Зазор держат только сигналы не менее важные: важный не ждёт менее важного.
  const slots = seen.slots.filter((slot) => slot.at + CUE_GAP_MS > now);
  const at = slots.reduce((free, slot) => (slot.priority >= priority ? Math.max(free, slot.at + CUE_GAP_MS) : free), now);
  if (at - now > CUE_MAX_WAIT_MS) return skip('busy');

  const ducked = speaking && priority < SPEECH_ATTENTION_MIN;
  return {
    history: {
      keys: seen.keys,
      lastPlayed: { ...seen.lastPlayed, [signal]: now },
      merged: { ...seen.merged, [signal]: 0 },
      doneTimes: signal === 'done' ? [...doneTimes, now] : doneTimes,
      slots: [...slots, { at, priority }],
    },
    decision: {
      verdict: 'play',
      delayMs: at - now,
      gainDb: ducked ? SPEECH_CUE_GAIN_DB : 0,
      duckVoice: speaking && priority >= SPEECH_ATTENTION_MIN,
    },
  };
}

/**
 * Решает пачку сигналов одного момента. Важные решаются первыми (порядок равных — как пришли), решения возвращаются в
 * порядке входа. Историю не меняет: отдаёт новую.
 */
export function decideCues(
  history: CueHistory,
  requests: readonly CueRequest[],
  at: { now: number; speaking: boolean },
): { history: CueHistory; decisions: CueDecision[] } {
  const order = requests.map((_, index) => index).sort((a, b) => CUE_PRIORITY[requests[b]!.signal] - CUE_PRIORITY[requests[a]!.signal]);
  const decisions: CueDecision[] = new Array<CueDecision>(requests.length);
  let next = history;
  for (const index of order) {
    const result = decideOne(next, requests[index]!, at.now, at.speaking);
    next = result.history;
    decisions[index] = result.decision;
  }
  return { history: next, decisions };
}

/** Счётчик решений для E2E: `globalThis.__parleyIslandCues[signal][verdict]`, по образцу `__parleyChimes`. */
export type IslandCueCounter = Partial<Record<IslandSignal, Record<CueDecision['verdict'], number>>>;

/**
 * Политика окна острова: держит историю, берёт время и речь из `deps` и пишет каждое решение в счётчик
 * `__parleyIslandCues`.
 */
export function createCuePolicy(deps: { now(): number; speaking(): boolean }): { decide(requests: readonly CueRequest[]): CueDecision[] } {
  let history = EMPTY_CUE_HISTORY;
  return {
    decide(requests) {
      const result = decideCues(history, requests, { now: deps.now(), speaking: deps.speaking() });
      history = result.history;
      const target = globalThis as { __parleyIslandCues?: IslandCueCounter };
      const counter = (target.__parleyIslandCues ??= {});
      requests.forEach((request, index) => {
        const verdict = result.decisions[index]!.verdict;
        const row = (counter[request.signal] ??= { play: 0, merge: 0, skip: 0 });
        row[verdict] += 1;
      });
      return result.decisions;
    },
  };
}
