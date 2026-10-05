/**
 * Учёт токенов (P36): откуда взяты цифры, насколько они свежи и полны.
 *
 * Правила (контракт измерений аудита экономии токенов):
 * - неизвестное остаётся `null`, а не нулём: «не знаем» и «ноль» — разные вещи, а сумма с неизвестным
 *   слагаемым тоже неизвестна;
 * - `input` — вход без кэша, `totalInput` — весь вход в понимании провайдера; друг к другу и к
 *   `cacheRead` они не прибавляются (у Claude `totalInput = input + cacheRead + cacheWrite`, у Codex это
 *   его `input_tokens`, где кэш уже внутри);
 * - один и тот же запрос не считается дважды: дельты склеиваются по нативному id запроса или по
 *   проверенному смещению записи, накопительные значения сравниваются внутри своей нити;
 * - в публичный `UsageSummary` нативные id, пути логов и карты соответствия не попадают: связывание и
 *   эпоха живут только в `FrozenUsage`, который лежит в карте работы, а наружу выходит без них.
 *
 * Токены — не деньги и не доля лимита подписки: ни одной такой величины здесь нет.
 */

/** Четыре счётчика и полный вход. Любой из них может быть неизвестен. */
export interface UsageCounters {
  /** Вход без кэша. */
  input: number | null;
  output: number | null;
  /** Чтение из кэша; `null` — провайдер не сообщил. */
  cacheRead: number | null;
  /** Запись в кэш; `null` — провайдер не сообщил (у Codex её нет в логе вовсе). */
  cacheWrite: number | null;
  /** Весь вход, как его считает провайдер; с `input` и `cacheRead` не складывается. */
  totalInput: number | null;
}

export type UsageSource =
  /** Живой индекс лога провайдера. */
  | 'native-index'
  /** Снимок, зафиксированный в карте при `report` или усыплении. */
  | 'frozen-snapshot'
  /** Снимок карт до P36: только вход и выход, без кэша и времени наблюдения. */
  | 'legacy-snapshot'
  | 'unavailable';

/**
 * - `complete` — каждый запрос учтён один раз, неоднозначностей нет;
 * - `partial` — итог нижняя граница: смешанные записи (поле есть не у всех), спад накопителя без
 *   доказанного сброса или другая неопределённость;
 * - `unknown` — наблюдений нет.
 */
export type UsageCompleteness = 'complete' | 'partial' | 'unknown';

export interface UsageAttribution {
  workId: string;
  sessionId: string;
  /** `null` — комната не определена: у сессии их может быть несколько, и делить расход нечем. */
  roomId: string | null;
  /** `null` — прогон не определён. */
  runId: string | null;
}

/** То, что уходит окну: счётчики и происхождение, без нативных идентификаторов. */
export interface UsageSummary extends UsageCounters {
  source: UsageSource;
  /** Время последней записи лога с usage, по которой посчитаны цифры; `null` — неизвестно. */
  observedAt: string | null;
  /** Цифры могли устареть: сессия идёт, а свежего подтверждённого индекса нет. */
  stale: boolean;
  completeness: UsageCompleteness;
  /**
   * `conversation` — только собственный лог разговора, подагенты и порождённые треды не включены;
   * `conversation-and-descendants` — к нему добавлены наблюдённые потомки (полнота их набора не
   * гарантируется).
   */
  coverage: 'conversation' | 'conversation-and-descendants';
  attribution?: UsageAttribution;
}

/** Снимок в карте работы: `binding` и `epoch` нужны, чтобы не принять чужой снимок за свой. */
export interface FrozenUsage extends UsageSummary {
  /** Id разговора у провайдера, к которому относится снимок. Наружу не отдаётся. */
  binding: string;
  /** Запуск процесса (`startedAtProcess`), при котором снимок снят; `null` — неизвестен. */
  epoch: string | null;
  /**
   * Снимок снят в момент ухода процесса (сон): закрытый период, дальше лог этого запуска не растёт.
   * `false` — снят `report` посреди работы: сессия после него идёт и пишет лог, снимок лишь нижняя граница.
   */
  closed: boolean;
}

/** Допуск на расхождение часов записи лога и момента запуска процесса. */
export const EPOCH_TOLERANCE_MS = 5000;

const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalInput'] as const;

const unknownCounters = (): UsageCounters => ({
  input: null,
  output: null,
  cacheRead: null,
  cacheWrite: null,
  totalInput: null,
});

/** Счётчик из недокументированного JSON: неотрицательное целое либо `null`. */
export function asCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Поле лога как наблюдение: нет поля или оно не число — `null`, а не 0 (в отличие от `tokenCount`). */
export function observedCount(source: Record<string, unknown>, key: string): number | null {
  return asCount(source[key]);
}

const sum = (a: number | null, b: number | null): number | null => {
  if (a === null || b === null) return null;
  const total = a + b;
  return Number.isSafeInteger(total) ? total : null;
};

/** Поле за полем: больше из известных. Для частичных дублей и роста накопителя. */
function maxCounters(a: UsageCounters, b: UsageCounters): UsageCounters {
  const result = unknownCounters();
  for (const field of FIELDS) {
    const x = a[field];
    const y = b[field];
    result[field] = x === null ? y : y === null ? x : Math.max(x, y);
  }
  return result;
}

const pick = (value: UsageCounters): UsageCounters => ({
  input: asCount(value.input),
  output: asCount(value.output),
  cacheRead: asCount(value.cacheRead),
  cacheWrite: asCount(value.cacheWrite),
  totalInput: asCount(value.totalInput),
});

/** Наблюдение из лога провайдера. Хранится только в памяти разбора, наружу не уходит. */
export type UsageObservation = (
  | {
      kind: 'delta';
      /** Нативный id запроса или сообщения (`msg:…`) либо проверенное смещение записи (`line:…`). */
      id: string;
    }
  | {
      kind: 'cumulative';
      /** Нить накопителя: значения сравниваются только внутри неё. */
      stream: string;
      /** Адаптер доказал, что накопитель начался заново: прежний период закрыт и войдёт в сумму. */
      reset?: boolean;
    }
) & {
  counters: UsageCounters;
  /** Время записи; `null` — у записи нет метки. */
  at: string | null;
  /** Запись потомка (подагента, порождённого треда). */
  child?: boolean;
};

/**
 * Копилка наблюдений одного разговора. Порядок прихода — порядок записей лога.
 *
 * - `delta` с уже виденным id — частичный дубль: поля склеиваются, запрос остаётся одним;
 * - `cumulative` растёт — берётся новое значение; падает без `reset` — неоднозначность: сумма не
 *   выдумывается, остаётся наибольшее и итог помечается неполным; с `reset` прежний период
 *   закрывается и прибавляется к новому.
 */
export function createUsageLedger() {
  const deltas = new Map<string, UsageCounters>();
  const streams = new Map<string, UsageCounters[]>();
  let ambiguous = false;
  let lastAt: string | null = null;
  let descendants = false;

  return {
    observe(observation: UsageObservation): void {
      const counters = pick(observation.counters);
      if (observation.at !== null && (lastAt === null || observation.at > lastAt)) lastAt = observation.at;
      if (observation.child === true) descendants = true;

      if (observation.kind === 'delta') {
        const known = deltas.get(observation.id);
        deltas.set(observation.id, known === undefined ? counters : maxCounters(known, counters));
        return;
      }

      const periods = streams.get(observation.stream);
      if (periods === undefined) {
        streams.set(observation.stream, [counters]);
        return;
      }
      const current = periods[periods.length - 1]!;
      if (observation.reset === true) {
        periods.push(counters);
        return;
      }
      if (FIELDS.some((field) => counters[field] !== null && current[field] !== null && counters[field]! < current[field]!)) {
        ambiguous = true;
      }
      periods[periods.length - 1] = maxCounters(current, counters);
    },

    summary(): UsageSummary {
      const contributions = [...deltas.values(), ...[...streams.values()].flat()];
      if (contributions.length === 0) return { ...unknownCounters(), ...unobserved('native-index') };

      const totals = unknownCounters();
      let mixed = false;
      for (const field of FIELDS) {
        const known = contributions.filter((item) => item[field] !== null);
        // Поле есть не у всех записей — сумма была бы заниженной, поэтому неизвестна.
        if (known.length === contributions.length) {
          totals[field] = contributions.reduce<number | null>((acc, item) => sum(acc, item[field]), 0);
        } else if (known.length > 0) {
          mixed = true;
        }
      }
      return {
        ...totals,
        source: 'native-index',
        observedAt: lastAt,
        stale: false,
        completeness: ambiguous || mixed ? 'partial' : 'complete',
        coverage: descendants ? 'conversation-and-descendants' : 'conversation',
      };
    },
  };
}

/** Итог без наблюдений: все счётчики неизвестны. */
function unobserved(source: UsageSource, stale = false): Omit<UsageSummary, keyof UsageCounters> {
  return {
    source,
    observedAt: null,
    stale,
    completeness: 'unknown',
    coverage: 'conversation',
  };
}

/** Снимок для карты: итог индекса плюс связывание, эпоха и признак закрытого периода. */
export function freezeUsage(
  usage: UsageSummary,
  context: { binding: string; epoch: string | null; closed: boolean },
): FrozenUsage {
  return {
    ...usage,
    source: 'frozen-snapshot',
    stale: false,
    binding: context.binding,
    epoch: context.epoch,
    closed: context.closed,
  };
}

/**
 * Итог по снимку карт до P36 (`SessionMetrics.tokens`): вход и выход были и остаются известными, а
 * кэш и полный вход — нет. Нормализация Codex (`input` без кэша, `cacheWrite` нулём) назад не
 * разворачивается: что кэш из этого числа и сколько записано, снимок не говорит.
 */
export function legacyUsage(tokens: { input: number; output: number } | null): UsageSummary {
  if (tokens === null) return { ...unknownCounters(), ...unobserved('unavailable') };
  return {
    ...unknownCounters(),
    input: asCount(tokens.input),
    output: asCount(tokens.output),
    ...unobserved('legacy-snapshot'),
  };
}

/** Публичная часть итога: счётчики и происхождение, без `binding`, `epoch` и любых чужих полей из карты. */
function publicOf(usage: UsageSummary): UsageSummary {
  const result: UsageSummary = {
    ...pick(usage),
    source: usage.source,
    observedAt: typeof usage.observedAt === 'string' ? usage.observedAt : null,
    stale: usage.stale === true,
    completeness: usage.completeness,
    coverage: usage.coverage,
  };
  if (usage.attribution !== undefined) result.attribution = usage.attribution;
  return result;
}

const hasCounters = (usage: UsageSummary): boolean => FIELDS.some((field) => usage[field] !== null);

export interface SelectUsageInput {
  /** Процесс сессии идёт: живой индекс может быть новее снимка. */
  active: boolean;
  /** Запуск текущего процесса (`startedAtProcess`); `null` — неизвестен, проверка эпохи пропускается. */
  epoch: string | null;
  /** Итог индекса лога ТОГО ЖЕ связывания (провайдер и id разговора проверяет вызывающий); `null` — лога нет. */
  live: UsageSummary | null;
  /**
   * Снимок из карты ТОГО ЖЕ связывания; `null` — снимка нет. `closed` и `epoch` читаются у `FrozenUsage`;
   * снимок до P36 их не имеет и считается закрытым.
   */
  frozen: (UsageSummary & { closed?: boolean; epoch?: string | null }) | null;
}

/**
 * Какие цифры показать сессии.
 *
 * Закрытый период — остановленная сессия, чей снимок снят в момент ухода процесса (сон) в этой же
 * эпохе: снимок как есть, перечитанный лог его не заменяет (его мог дописать кто-то другой).
 * Во всех прочих случаях побеждает свежий валидный индекс: у идущей сессии свежий — последняя запись
 * usage не раньше запуска текущего процесса (с допуском часов), иначе это наблюдение прошлой эпохи; у
 * остановленной — любой индекс того же связывания, потому что снимок `report` снят посреди работы и
 * всё записанное после него в нём потеряно, а сессия могла уйти в `closed` без `finishSession`. Если
 * лог при этом «похудел» против снимка (ротация, усечение), итог — наибольшие поля и неполный. Нет
 * свежего индекса — снимок с пометкой «устарел», нет и его — `unavailable`.
 */
export function selectUsage({ active, epoch, live, frozen }: SelectUsageInput): UsageSummary {
  const liveUsage = live !== null && live.source === 'native-index' && hasCounters(live) ? publicOf(live) : null;
  const snapshot = frozen !== null && hasCounters(frozen) ? publicOf(frozen) : null;

  const snapshotClosed = frozen?.closed !== false && (frozen?.epoch === undefined || frozen.epoch === epoch);
  if (!active && snapshot !== null && snapshotClosed) return snapshot;

  const launch = epoch === null ? Number.NaN : Date.parse(epoch);
  const observed = liveUsage?.observedAt == null ? Number.NaN : Date.parse(liveUsage.observedAt);
  const fresh =
    liveUsage !== null && (!active || Number.isNaN(launch) || observed >= launch - EPOCH_TOLERANCE_MS);

  if (liveUsage !== null && fresh) {
    if (snapshot === null || !FIELDS.some((field) => regressed(liveUsage[field], snapshot[field]))) {
      return liveUsage;
    }
    return { ...liveUsage, ...maxCounters(liveUsage, snapshot), completeness: 'partial' };
  }
  // Снимок честнее устаревшего индекса, но и он помечен: свежего подтверждения нет.
  if (snapshot !== null) return { ...snapshot, stale: true };
  return liveUsage !== null ? { ...liveUsage, stale: true } : { ...unknownCounters(), ...unobserved('unavailable', active) };
}

const regressed = (live: number | null, frozen: number | null): boolean =>
  live !== null && frozen !== null && live < frozen;

/** Итоги разных сессий с ключом разговора (провайдер + id у провайдера; эпоха в ключ не входит). */
export interface KeyedUsage {
  key: string;
  usage: UsageSummary;
}

export interface UsageTotal extends UsageCounters {
  completeness: UsageCompleteness;
  stale: boolean;
  /** Сколько разных разговоров вошло в итог. */
  conversations: number;
}

/**
 * Сумма по разным разговорам. Один разговор в двух видах (две записи карты с одним нативным id) входит
 * один раз: побеждает наблюдение свежее. Неизвестное поле одного слагаемого делает неизвестной сумму,
 * а неполное или устаревшее слагаемое — весь итог.
 */
export function sumUsage(entries: KeyedUsage[]): UsageTotal {
  const distinct = new Map<string, UsageSummary>();
  for (const { key, usage } of entries) {
    const known = distinct.get(key);
    if (known === undefined || (usage.observedAt ?? '') > (known.observedAt ?? '')) distinct.set(key, usage);
  }
  const values = [...distinct.values()];
  const totals = unknownCounters();
  if (values.length > 0) {
    for (const field of FIELDS) {
      totals[field] = values.reduce<number | null>((acc, item) => sum(acc, item[field]), 0);
    }
  }
  return {
    ...totals,
    completeness:
      values.length === 0 ? 'unknown' : values.every((item) => item.completeness === 'complete') ? 'complete' : 'partial',
    stale: values.some((item) => item.stale),
    conversations: values.length,
  };
}
