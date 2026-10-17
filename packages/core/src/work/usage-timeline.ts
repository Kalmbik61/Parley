import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { adapterV1 } from '../adapter-v1.js';
import type { RawRecord } from '../jsonl.js';
import { createUsageLedger, type UsageObservation, type UsageSummary, type UsageWindow } from './usage-ledger.js';
import {
  claudeUsageObservation,
  codexUsageObservation,
  noteClaudeSidechain,
  replayClaudeUsage,
  type ClaudeSidechain,
} from './usage-observations.js';

/** Кусок чтения лога: больше за раз в память не берём. */
const READ_CHUNK_BYTES = 1024 * 1024;
const LF = 0x0a;

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

export interface TimelineReader {
  stat(file: string): Promise<{ size: number; ino: number }>;
  open(file: string, start: number): NodeJS.ReadableStream;
}

export const DEFAULT_TIMELINE_READER: TimelineReader = {
  stat: async (file) => {
    const { size, ino } = await stat(file);
    return { size, ino };
  },
  open: (file, start) => createReadStream(file, { start, highWaterMark: READ_CHUNK_BYTES }),
};

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

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/** Строка → запись-объект или null (пустая, битая, не объект — как в `forEachJsonlRecord`). */
function parseLine(line: Buffer): RawRecord | null {
  const trimmed = line.toString('utf8').trim();
  if (trimmed === '') return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as RawRecord) : null;
  } catch {
    return null;
  }
}

/**
 * Дочитывает лог с `previous.offset` и возвращает НОВУЮ шкалу (прежняя не меняется). Усечение
 * (`size < offset`) или подмена файла (другой `ino`) — чтение с нуля. Оборванная последняя строка ждёт
 * следующего вызова; целая (JSON-объект) без `\n` принимается сразу, как у readline.
 */
export async function extendUsageTimeline(
  previous: UsageTimeline | null,
  file: string,
  family: 'claude' | 'codex',
  reader: TimelineReader = DEFAULT_TIMELINE_READER,
): Promise<UsageTimeline> {
  let current: { size: number; ino: number };
  try {
    current = await reader.stat(file);
  } catch (error) {
    if (isMissing(error)) return emptyTimeline(file, family);
    throw error;
  }

  const base =
    previous !== null && previous.family === family && previous.ino === current.ino && current.size >= previous.offset
      ? previous
      : emptyTimeline(file, family);
  const start = base.offset;
  const observations = [...base.observations];
  const sidechain: ClaudeSidechain | undefined =
    family === 'claude'
      ? { agents: new Set(base.sidechain?.agents), unidentified: base.sidechain?.unidentified ?? false }
      : undefined;
  let lineNo = base.lineNo;
  let skipLf = base.unterminated === true;
  let unterminated = false;

  const onRecord = (raw: RawRecord): void => {
    if (family === 'claude') {
      const record = adapterV1.toSessionRecord(raw);
      const observation = claudeUsageObservation(record, file, lineNo);
      if (observation !== null) {
        observations.push(observation);
        if (sidechain !== undefined) noteClaudeSidechain(sidechain, record);
      }
      return;
    }
    const observation = codexUsageObservation(raw);
    if (observation !== null) observations.push(observation);
  };

  // Ничего нового (и хвост не ждёт дописывания): файл открывать незачем.
  if (current.size === start) return { ...base, size: start, observations, ...(sidechain ? { sidechain } : {}) };

  let consumed = start;
  let bytesRead = 0;
  let carry: Buffer = Buffer.alloc(0);
  let stream: NodeJS.ReadableStream;
  try {
    stream = reader.open(file, start);
  } catch (error) {
    if (isMissing(error)) return emptyTimeline(file, family);
    throw error;
  }
  try {
    for await (const chunk of stream) {
      const piece = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
      bytesRead += piece.length;
      let data = carry.length === 0 ? piece : Buffer.concat([carry, piece]);
      if (skipLf && data.length > 0) {
        skipLf = false;
        if (data[0] === LF) {
          data = data.subarray(1);
          consumed += 1;
        }
      }
      let pos = 0;
      for (let end = data.indexOf(LF, pos); end !== -1; end = data.indexOf(LF, pos)) {
        lineNo++;
        const raw = parseLine(data.subarray(pos, end));
        if (raw !== null) onRecord(raw);
        consumed += end + 1 - pos;
        pos = end + 1;
      }
      carry = data.subarray(pos);
    }
  } catch (error) {
    if (isMissing(error)) return emptyTimeline(file, family);
    throw error;
  } finally {
    (stream as { destroy?: () => void }).destroy?.();
  }

  // Хвост без `\n`: целый объект считается сразу, иначе ждёт дописывания (offset остаётся на его начале).
  if (carry.length > 0) {
    const raw = parseLine(carry);
    if (raw !== null) {
      lineNo++;
      onRecord(raw);
      consumed += carry.length;
      unterminated = true;
    }
  }

  return {
    file,
    family,
    offset: consumed,
    size: start + bytesRead,
    ino: current.ino,
    lineNo,
    observations,
    ...(sidechain !== undefined ? { sidechain } : {}),
    ...(unterminated ? { unterminated: true } : {}),
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
