import path from 'node:path';
import { Counter, oneLine, type TokenTotals } from '../counters.js';
import { forEachJsonlRecord, type RawRecord } from '../jsonl.js';
import { INDEX_READ_CONCURRENCY, mapLimited } from '../map-limited.js';
import type { SessionIndex } from '../session-index.js';
import { isPointerText } from '../work/delivery.js';
import { createUsageLedger, observedCount } from '../work/usage-ledger.js';
import { defaultCodexRoot, discoverCodexSessions } from './discover.js';

function asRecord(value: unknown): RawRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RawRecord)
    : null;
}

function str(source: RawRecord | null, key: string): string | null {
  if (source === null) return null;
  const value = source[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * `total_token_usage` записи `token_count` как наблюдение для учёта токенов (он накопительный, поэтому
 * берётся последняя такая запись, а не сумма). Поля, которых в записи нет, остаются
 * `null`: `cacheWrite` у Codex не наблюдается никогда (в логе нет такого счётчика) и нулём не
 * подменяется. `input_tokens` у Codex уже включает кэш, поэтому он же — полный вход, а вход без кэша
 * известен, только если известен и кэш.
 */
function codexCounters(payload: RawRecord) {
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

/** Первый текстовый блок content[] — там `{type: 'input_text', text}`. */
function firstContentText(payload: RawRecord): string | null {
  const content = payload['content'];
  if (!Array.isArray(content)) return null;
  for (const item of content) {
    const block = asRecord(item);
    const text = str(block, 'text');
    if (text !== null) return text;
  }
  return null;
}

/**
 * `session_meta` порождённого треда: подагента, внутреннего треда или неинтерактивного запуска.
 * Признаки — заданный `parent_thread_id` и `source`, отличный от `cli` (`"exec"`, `{"subagent": …}`,
 * `{"internal": …}`; `codex-rs/protocol/src/protocol.rs`). Лога без `source` (Codex до появления поля)
 * это не касается: пустого значения мало, чтобы записать тред в порождённые, и старая привязка по
 * cwd и времени для него остаётся.
 */
function isSpawnedMeta(payload: RawRecord): boolean {
  const parent = payload['parent_thread_id'];
  if (typeof parent === 'string' ? parent !== '' : parent !== undefined && parent !== null) {
    return true;
  }
  const source = payload['source'];
  return source !== undefined && source !== null && source !== 'cli';
}

/**
 * Родитель порождённого треда по родным признакам `session_meta`: `parent_thread_id` либо, у подагента,
 * `source.subagent.thread_spawn.parent_thread_id`. По времени и cwd родителя не угадываем.
 */
function parentThreadId(payload: RawRecord): string | null {
  const direct = str(payload, 'parent_thread_id');
  if (direct !== null) return direct;
  const source = asRecord(payload['source']);
  const spawn = asRecord(asRecord(source?.['subagent'])?.['thread_spawn']);
  return str(spawn, 'parent_thread_id');
}

/**
 * Индексирует один rollout-лог Codex в общую модель SessionIndex.
 *
 * Формат другой во всём (см. specs/runners.md): вся мета в одной записи
 * `session_meta`, модель в `turn_context`, инструменты в `function_call`.
 * Наружу при этом отдаётся ровно тот же SessionIndex, что и у Claude Code, —
 * UI о различиях не знает. `signal` прерывает чтение (`forEachJsonlRecord`).
 */
export async function indexCodexSession(file: string, signal?: AbortSignal): Promise<SessionIndex> {
  const models = new Counter();
  const tools = new Counter();
  const roles = new Counter();
  const recordTypes = new Counter();

  let id: string | null = null;
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let version: string | null = null;
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  let firstUserMessage: string | null = null;
  let lastUserRecordAt: string | null = null;
  let lastCounters = null as ReturnType<typeof codexCounters>;
  const ledger = createUsageLedger();
  let lastTurnEvent: SessionIndex['lastTurnEvent'];
  let spawned = false;
  let parentId: string | null = null;
  let forkedFrom: string | null = null;

  const onRecord = (raw: RawRecord): void => {
    const type = str(raw, 'type');
    const payload = asRecord(raw['payload']);
    recordTypes.add(type);

    const at = str(raw, 'timestamp');
    if (at !== null) {
      if (startedAt === null || at < startedAt) startedAt = at;
      if (endedAt === null || at > endedAt) endedAt = at;
    }

    if (payload === null) return;
    const kind = str(payload, 'type');

    switch (type) {
      case 'session_meta': {
        id ??= str(payload, 'id');
        cwd ??= str(payload, 'cwd');
        version ??= str(payload, 'cli_version');
        gitBranch ??= str(asRecord(payload['git']), 'branch');
        spawned ||= isSpawnedMeta(payload);
        parentId ??= parentThreadId(payload);
        forkedFrom ??= str(payload, 'forked_from_id');
        break;
      }

      case 'turn_context': {
        // Модель меняется между ходами — считаем каждый ход.
        models.add(str(payload, 'model'));
        cwd ??= str(payload, 'cwd');
        break;
      }

      case 'response_item': {
        if (kind === 'message') roles.add(str(payload, 'role'));
        // Инструменты вызываются и обычные, и «кастомные» — считаем оба вида.
        if (kind === 'function_call' || kind === 'custom_tool_call') {
          tools.add(str(payload, 'name'));
        }
        break;
      }

      case 'event_msg': {
        if (
          at !== null &&
          (kind === 'task_started' || kind === 'task_complete' || kind === 'turn_aborted')
        ) {
          lastTurnEvent = { type: kind, at };
        }
        // Заголовок сессии — первая РЕПЛИКА ЧЕЛОВЕКА. Сообщения из response_item
        // для этого не годятся: там же едут системные инструкции и AGENTS.md.
        if (kind === 'user_message') {
          firstUserMessage ??= str(payload, 'message') ?? firstContentText(payload);
          // Результаты инструментов у Codex едут не сообщениями пользователя, так
          // что отметка страховки здесь — ровно реплика человека (раздел 4.3).
          if (at !== null && (lastUserRecordAt === null || at > lastUserRecordAt)) {
            lastUserRecordAt = at;
          }
        }
        if (kind === 'token_count') {
          // Накопитель сессии: одна нить на лог. Падение значения без доказанного сброса учёт не
          // суммирует и не угадывает — итог остаётся наибольшим и помечается неполным.
          const counters = codexCounters(payload);
          if (counters !== null) {
            lastCounters = counters;
            ledger.observe({ kind: 'cumulative', stream: 'rollout', counters, at });
          }
        }
        break;
      }

      default:
        break;
    }
  };
  const stats = await forEachJsonlRecord(file, onRecord, signal);

  const durationMs =
    startedAt !== null && endedAt !== null
      ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt))
      : null;

  // `tokens` — для показа: неизвестное поле показывается нулём, а в `usage` остаётся null. Запись в кэш у
  // Codex не наблюдается никогда, поэтому здесь по-прежнему 0.
  const tokens: TokenTotals | null =
    lastCounters === null
      ? null
      : {
          input: lastCounters.input ?? 0,
          output: lastCounters.output ?? 0,
          cacheRead: lastCounters.cacheRead ?? 0,
          cacheWrite: 0,
        };

  const title = firstUserMessage === null ? null : oneLine(firstUserMessage);

  return {
    id: id ?? path.basename(file, '.jsonl'),
    // Слага проекта у Codex нет — берём имя каталога из cwd.
    project: cwd === null ? '—' : path.basename(cwd),
    projectPath: cwd,
    cwd,
    gitBranch,
    version,
    file,
    title,
    titleSource: title === null ? null : 'first-text',
    startedAt,
    endedAt,
    lastUserRecordAt,
    // У Codex служебного хвоста после хода нет в этом смысле: время работы — время последней записи.
    lastWorkRecordAt: endedAt,
    ...(lastTurnEvent === undefined ? {} : { lastTurnEvent }),
    durationMs,
    records: stats.parsed,
    malformedLines: stats.malformed,
    models: models.toObject(),
    tools: tools.toObject(),
    roles: roles.toObject(),
    recordTypes: recordTypes.toObject(),
    primaryModel: models.top(),
    // Субагентов у Codex нет как явления.
    subsessionCount: 0,
    tokens,
    usage: ledger.summary(),
    provider: 'codex',
    ...(spawned ? { spawned: true } : {}),
    ...(parentId === null ? {} : { parentId }),
    ...(forkedFrom === null ? {} : { forkedFrom }),
    ...(firstUserMessage !== null && isPointerText(firstUserMessage) ? { firstPromptPointer: true as const } : {}),
  };
}

/** Индекс всех сессий Codex, свежие первыми. `signal` прерывает чтение — как у `buildIndex`. */
export async function buildCodexIndex(
  root: string = defaultCodexRoot(),
  signal?: AbortSignal,
): Promise<SessionIndex[]> {
  const discovered = await discoverCodexSessions(root);
  // Не больше INDEX_READ_CONCURRENCY файлов разом — как у истории Claude (lane-r3, п. 1).
  const index = await mapLimited(discovered, INDEX_READ_CONCURRENCY, (session) =>
    indexCodexSession(session.file, signal),
  );
  index.sort((a, b) => String(b.endedAt ?? '').localeCompare(String(a.endedAt ?? '')));
  return index;
}
