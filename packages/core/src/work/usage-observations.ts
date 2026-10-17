import type { SessionRecord } from '../adapter-v1.js';
import type { RawRecord } from '../jsonl.js';
import { createUsageLedger, observedCount, type UsageCounters, type UsageObservation } from './usage-ledger.js';

/** Тот же ledger, что отдаёт `createUsageLedger`: отдельного типа в учёте нет. */
export type UsageLedger = ReturnType<typeof createUsageLedger>;

/** Состояние sidechain родителя: чьи записи агентов он несёт у себя и были ли среди них без id ответа. */
export interface ClaudeSidechain {
  agents: Set<string | null>;
  unidentified: boolean;
}

function asRecord(value: unknown): RawRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RawRecord)
    : null;
}

/** Счётчики записи ответа Claude: `input_tokens` — вход без кэша, полный вход — сумма трёх частей. */
export function claudeCounters({ input, output, cacheRead, cacheWrite }: NonNullable<SessionRecord['usage']>): UsageCounters {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalInput: input === null || cacheRead === null || cacheWrite === null ? null : input + cacheRead + cacheWrite,
  };
}

/**
 * `total_token_usage` записи `token_count` как наблюдение для учёта токенов (он накопительный, поэтому
 * берётся последняя такая запись, а не сумма). Поля, которых в записи нет, остаются
 * `null`: `cacheWrite` у Codex не наблюдается никогда (в логе нет такого счётчика) и нулём не
 * подменяется. `input_tokens` у Codex уже включает кэш, поэтому он же — полный вход, а вход без кэша
 * известен, только если известен и кэш.
 */
export function codexCounters(payload: RawRecord): UsageCounters | null {
  const info = asRecord(payload['info']);
  const total = info === null ? null : asRecord(info['total_token_usage']);
  if (total === null) return null;

  const totalInput = observedCount(total, 'input_tokens');
  const cacheRead = observedCount(total, 'cached_input_tokens');
  return {
    input: totalInput === null || cacheRead === null ? null : Math.max(0, totalInput - cacheRead),
    output: observedCount(total, 'output_tokens'),
    cacheRead,
    cacheWrite: null,
    totalInput,
  };
}

/**
 * Запись лога Claude → наблюдение учёта. Токены считаются только по ответам модели: usage в реплике
 * человека — отчёт об уже учтённом вызове инструмента, повторный счёт.
 *
 * Один ответ модели Claude Code пишет несколькими записями (по одной на блок content), и КАЖДАЯ несёт
 * полный usage всего ответа, поэтому id — `msg:<message.id>`. У записей без message.id склеивать не
 * по чему: их id — проверенное смещение записи `line:<файл>:<номер строки>`.
 */
export function claudeUsageObservation(record: SessionRecord, file: string, lineNo: number): UsageObservation | null {
  if (record.role !== 'assistant' || record.usage === null) return null;
  return {
    kind: 'delta',
    id: record.messageId === null ? `line:${file}:${lineNo}` : `msg:${record.messageId}`,
    counters: claudeCounters(record.usage),
    at: record.timestamp,
  };
}

/**
 * Родитель старых версий Claude Code пишет записи агента и у себя (`isSidechain`): их же несёт и файл
 * агента, поэтому по ним решается, можно ли склеить два файла по id ответа. Копится только по записям,
 * которые учитываются (ответ модели с usage).
 */
export function noteClaudeSidechain(state: ClaudeSidechain, record: SessionRecord): void {
  if (record.role !== 'assistant' || record.usage === null || !record.isSidechain) return;
  state.agents.add(record.agentId);
  if (record.messageId === null) state.unidentified = true;
}

/** Сырая запись rollout Codex → наблюдение cumulative по `token_count` или null. */
export function codexUsageObservation(raw: RawRecord): UsageObservation | null {
  if (raw['type'] !== 'event_msg') return null;
  const payload = asRecord(raw['payload']);
  if (payload === null || payload['type'] !== 'token_count') return null;
  // Накопитель сессии: одна нить на лог. Падение значения без доказанного сброса учёт не
  // суммирует и не угадывает — итог остаётся наибольшим и помечается неполным.
  const counters = codexCounters(payload);
  if (counters === null) return null;
  const at = typeof raw['timestamp'] === 'string' && raw['timestamp'] !== '' ? raw['timestamp'] : null;
  return { kind: 'cumulative', stream: 'rollout', counters, at };
}

/**
 * Один ledger: наблюдения родителя, затем подагентов с `child: true`. Запись агента, которую родитель
 * уже записал у себя: без общего id ответа она не склеивается, и чем из двух копий её считать, не
 * доказать — не учитывается, итог неполный (`markAmbiguous`).
 */
export function replayClaudeUsage(
  ledger: UsageLedger,
  parent: { observations: readonly UsageObservation[]; sidechain: ClaudeSidechain },
  subagents: ReadonlyArray<{ agentId: string | null; observations: readonly UsageObservation[] }>,
): void {
  for (const observation of parent.observations) ledger.observe(observation);
  const { agents, unidentified } = parent.sidechain;
  for (const subagent of subagents) {
    for (const observation of subagent.observations) {
      const unmerged = observation.kind === 'delta' && observation.id.startsWith('line:');
      if ((agents.has(subagent.agentId) || agents.has(null)) && (unmerged || unidentified)) {
        ledger.markAmbiguous();
        continue;
      }
      ledger.observe({ ...observation, child: true });
    }
  }
}
