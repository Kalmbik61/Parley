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
  /** Последняя строка принята без `\n`: перевод строки, пришедший позже, не начинает новую пустую. */
  unterminated?: boolean;
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
 * Дочитывает лог с `previous.offset` и возвращает НОВУЮ шкалу (прежняя не меняется). Усечение
 * (`size < offset`) или подмена файла (другой `ino`) — чтение с нуля. Оборванная последняя строка ждёт
 * следующего вызова; целая (JSON-объект) без `\n` принимается сразу, как у readline. Само чтение —
 * `readJsonlTail`. `adapter` разбирает записи Claude так же, как в полном чтении индексатора.
 */
export async function extendUsageTimeline(
  previous: UsageTimeline | null,
  file: string,
  family: 'claude' | 'codex',
  reader: TimelineReader = DEFAULT_TIMELINE_READER,
  adapter: SchemaAdapter = adapterV1,
): Promise<UsageTimeline> {
  const prior = previous !== null && previous.family === family ? previous : null;
  // Черновик заводится только когда есть что менять; прежняя шкала не мутируется никогда.
  type Draft = { observations: UsageObservation[]; sidechain: ClaudeSidechain | undefined };
  let draft: Draft | null = null;
  const fresh = (): Draft => ({
    observations: [],
    sidechain: family === 'claude' ? { agents: new Set<string | null>(), unidentified: false } : undefined,
  });
  const copyOfPrior = (): Draft => ({
    observations: [...(prior?.observations ?? [])],
    sidechain:
      family === 'claude'
        ? { agents: new Set(prior?.sidechain?.agents), unidentified: prior?.sidechain?.unidentified ?? false }
        : undefined,
  });

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
      draft = fresh();
    },
    record: (raw, lineNo) => {
      draft ??= copyOfPrior();
      if (family === 'claude') {
        const record = adapter.toSessionRecord(raw);
        const observation = claudeUsageObservation(record, file, lineNo);
        if (observation !== null) {
          draft.observations.push(observation);
          if (draft.sidechain !== undefined) noteClaudeSidechain(draft.sidechain, record);
        }
        return;
      }
      const observation = codexUsageObservation(raw);
      if (observation !== null) draft.observations.push(observation);
    },
  });
  if (result.missing) return emptyTimeline(file, family);

  const kept = draft as Draft | null;
  const observations = kept?.observations ?? prior?.observations ?? [];
  const sidechain = kept === null ? prior?.sidechain : kept.sidechain;
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
    ...(next.unterminated ? { unterminated: true } : {}),
  };
}

/** Срез расхода Claude по окнам: тот же итог, что у индексатора с `usageWindows`, без чтения файлов. */
export function claudeUsageFromTimelines(
  parent: UsageTimeline,
  subagents: readonly SubagentTimeline[],
  windows: readonly UsageWindow[],
): UsageSummary {
  const ledger = createUsageLedger({ windows });
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
