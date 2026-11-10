import { adapterV1, type SchemaAdapter } from '../adapter-v1.js';
import { DEFAULT_TIMELINE_READER, readJsonlTail, type TailCursor, type TimelineReader } from '../jsonl-tail.js';
import { createUsageLedger, type UsageObservation, type UsageSummary, type UsageWindow } from './usage-ledger.js';
import {
  claudeUsageObservation,
  codexUsageObservation,
  noteClaudeSidechain,
  replayClaudeUsage,
  type ClaudeSidechain,
} from './usage-observations.js';

export { DEFAULT_TIMELINE_READER, type TimelineReader };

/**
 * Шкала расхода одного лога: наблюдения учёта с места, до которого файл уже прочитан. Следующий вызов
 * дочитывает только дописанное, а срез по окнам проигрывается из наблюдений без чтения файла.
 */
export interface UsageTimeline {
  file: string;
  family: 'claude' | 'codex';
  /** Байт, до которого лог разобран целыми строками: следующее чтение начинается отсюда. */
  offset: number;
  /** Сколько байт файла прочитано (по факту чтения, не по `stat`: файл мог дорасти между ними). */
  size: number;
  ino: number;
  /** Номер последней разобранной строки: нужен для id `line:<файл>:<номер>` как у полного перечита. */
  lineNo: number;
  observations: readonly UsageObservation[];
  /** Только у Claude. */
  sidechain?: ClaudeSidechain;
  /** Только у Claude: накопитель стоимости (`cost-state`) в порядке файла. */
  costs?: readonly CostPoint[];
  /** Метка последней записи с временем: от неё берётся время следующего `cost-state`. */
  lastStamp?: string | null;
  /** Последняя строка принята без `\n`: перевод строки, пришедший позже, не начинает новую пустую. */
  unterminated?: boolean;
}

/**
 * Точка накопителя стоимости Claude Code: запись `cost-state` (`totalCostUSD` растёт через resume и форк). Времени у
 * записи нет — берётся метка ближайшей предыдущей записи файла, у которой она есть. `unknown` — `hasUnknownModelCost`.
 */
export interface CostPoint {
  at: string;
  total: number;
  unknown: boolean;
}

/** Подагент для среза: шкала его файла и id агента (по нему решается склейка с sidechain родителя). */
export type SubagentTimeline = UsageTimeline & { agentId: string | null };

function emptyTimeline(file: string, family: 'claude' | 'codex'): UsageTimeline {
  return {
    file,
    family,
    offset: 0,
    size: 0,
    ino: 0,
    lineNo: 0,
    observations: [],
    ...(family === 'claude' ? { sidechain: { agents: new Set<string | null>(), unidentified: false } } : {}),
  };
}

/**
 * Дочитывает лог с `previous.offset` и возвращает шкалу с новым курсором. Усечение (`size < offset`) или
 * подмена файла (другой `ino`) — чтение с нуля, шкала целиком новая. Иначе новые наблюдения, точки стоимости и
 * `sidechain` копятся в буфере и ПОСЛЕ удачного чтения дописываются в массивы прежней шкалы на месте (без копии
 * на каждое дописывание); чтение, упавшее посреди хвоста, шкалу не меняет. Прежний объект шкалы после вызова
 * заменяется возвращённым: держать его для сравнения нельзя. Оборванная последняя строка ждёт следующего
 * вызова; целая (JSON-объект) без `\n` принимается сразу, как у readline. Само чтение — `readJsonlTail`.
 * `adapter` разбирает записи Claude так же, как в полном чтении индексатора.
 */
export async function extendUsageTimeline(
  previous: UsageTimeline | null,
  file: string,
  family: 'claude' | 'codex',
  reader: TimelineReader = DEFAULT_TIMELINE_READER,
  adapter: SchemaAdapter = adapterV1,
): Promise<UsageTimeline> {
  const prior = previous !== null && previous.family === family ? previous : null;
  type Buffer_ = {
    observations: UsageObservation[];
    sidechain: ClaudeSidechain | undefined;
    costs: CostPoint[];
    lastStamp: string | null;
  };
  const fresh = (lastStamp: string | null): Buffer_ => ({
    observations: [],
    sidechain: family === 'claude' ? { agents: new Set<string | null>(), unidentified: false } : undefined,
    costs: [],
    lastStamp,
  });
  // Буфер новых записей; `restarted` — чтение началось с нуля, прежняя шкала не продолжается.
  let buffer = fresh(prior?.lastStamp ?? null);
  let restarted = false;

  const cursor: TailCursor | null =
    prior === null
      ? null
      : {
          offset: prior.offset,
          size: prior.size,
          ino: prior.ino,
          lineNo: prior.lineNo,
          unterminated: prior.unterminated === true,
          pendingMalformed: false,
        };

  const result = await readJsonlTail(cursor, file, reader, {
    reset: () => {
      buffer = fresh(null);
      restarted = true;
    },
    record: (raw, lineNo) => {
      if (family === 'claude') {
        const stamp = typeof raw['timestamp'] === 'string' ? raw['timestamp'] : null;
        if (raw['type'] === 'cost-state') {
          const total = raw['totalCostUSD'];
          if (buffer.lastStamp !== null && typeof total === 'number' && Number.isFinite(total)) {
            buffer.costs.push({ at: buffer.lastStamp, total, unknown: raw['hasUnknownModelCost'] === true });
          }
          return;
        }
        if (stamp !== null) buffer.lastStamp = stamp;
        const record = adapter.toSessionRecord(raw);
        const observation = claudeUsageObservation(record, file, lineNo);
        if (observation !== null) {
          buffer.observations.push(observation);
          if (buffer.sidechain !== undefined) noteClaudeSidechain(buffer.sidechain, record);
        }
        return;
      }
      const observation = codexUsageObservation(raw);
      if (observation !== null) buffer.observations.push(observation);
    },
  });
  if (result.missing) return emptyTimeline(file, family);

  let observations: UsageObservation[];
  let sidechain: ClaudeSidechain | undefined;
  let costs: CostPoint[] | undefined;
  let lastStamp: string | null | undefined;
  if (prior === null || restarted) {
    ({ observations, sidechain, costs, lastStamp } = buffer);
  } else {
    // Чтение удалось: буфер дописывается в массивы прежней шкалы на месте.
    observations = prior.observations as UsageObservation[];
    for (const item of buffer.observations) observations.push(item);
    sidechain = prior.sidechain;
    if (buffer.sidechain !== undefined) {
      sidechain ??= { agents: new Set<string | null>(), unidentified: false };
      for (const agent of buffer.sidechain.agents) sidechain.agents.add(agent);
      if (buffer.sidechain.unidentified) sidechain.unidentified = true;
    }
    costs = prior.costs as CostPoint[] | undefined;
    if (buffer.costs.length > 0) {
      costs ??= [];
      for (const point of buffer.costs) costs.push(point);
    }
    lastStamp = buffer.lastStamp ?? prior.lastStamp;
  }
  const { cursor: next } = result;
  return {
    file,
    family,
    offset: next.offset,
    size: next.size,
    ino: next.ino,
    lineNo: next.lineNo,
    observations,
    ...(sidechain !== undefined ? { sidechain } : {}),
    ...(family === 'claude' && costs !== undefined ? { costs } : {}),
    ...(family === 'claude' && lastStamp !== undefined ? { lastStamp } : {}),
    ...(next.unterminated ? { unterminated: true } : {}),
  };
}

/** Срез расхода Claude по окнам: тот же итог, что у индексатора с `usageWindows`, без чтения файлов. */
export function claudeUsageFromTimelines(
  parent: UsageTimeline,
  subagents: readonly SubagentTimeline[],
  windows: readonly UsageWindow[],
  excludeIds?: ReadonlySet<string>,
): UsageSummary {
  const ledger = createUsageLedger({ windows, ...(excludeIds === undefined ? {} : { excludeIds }) });
  replayClaudeUsage(
    ledger,
    { observations: parent.observations, sidechain: parent.sidechain ?? { agents: new Set(), unidentified: false } },
    subagents,
  );
  return ledger.summary();
}

/** Срез расхода Codex по окнам. */
export function codexUsageFromTimeline(timeline: UsageTimeline, windows: readonly UsageWindow[]): UsageSummary {
  const ledger = createUsageLedger({ windows });
  for (const observation of timeline.observations) ledger.observe(observation);
  return ledger.summary();
}

/**
 * Нативные id ответов (`msg:…`) лога Claude внутри окон: по ним следующий отрезок отсекает копии прежних ответов,
 * которые форк несёт в своём логе (спека передачи 5.9). Записи без нативного id (`line:…`) не в счёт.
 */
export function claudeDeltaIdsIn(
  parent: UsageTimeline,
  subagents: readonly SubagentTimeline[],
  windows: readonly UsageWindow[],
): Set<string> {
  const from = windows.map((window) => ({ from: Date.parse(window.from), to: window.to === null ? Number.POSITIVE_INFINITY : Date.parse(window.to) }));
  const ids = new Set<string>();
  for (const timeline of [parent, ...subagents]) {
    for (const observation of timeline.observations) {
      if (observation.kind !== 'delta' || !observation.id.startsWith('msg:') || observation.at === null) continue;
      const t = Date.parse(observation.at);
      if (from.some((span) => t >= span.from && t < span.to)) ids.add(observation.id);
    }
  }
  return ids;
}

/**
 * Стоимость Claude Code за окно `[from, to)`: последнее значение накопителя `cost-state` до конца окна минус последнее
 * до начала. Нет записи до начала: отрезок с начала разговора (в логе нет наблюдений раньше окна) — база ноль, иначе
 * `null`; `hasUnknownModelCost` на любом краю или нет записи в окне — `null`. Своих цен нет.
 */
export function claudeCostIn(timeline: UsageTimeline, window: UsageWindow): number | null {
  const from = Date.parse(window.from);
  const to = window.to === null ? Number.POSITIVE_INFINITY : Date.parse(window.to);
  const costs = timeline.costs ?? [];
  const lastBefore = (limit: number, inclusive: boolean): CostPoint | undefined =>
    [...costs].reverse().find((point) => (inclusive ? Date.parse(point.at) <= limit : Date.parse(point.at) < limit));
  const end = lastBefore(to, true);
  if (end === undefined || end.unknown) return null;
  const base = lastBefore(from, false);
  if (base === undefined) {
    const earlier = timeline.observations.some((observation) => observation.at !== null && Date.parse(observation.at) < from);
    return earlier ? null : end.total;
  }
  return base.unknown ? null : Math.max(0, end.total - base.total);
}
