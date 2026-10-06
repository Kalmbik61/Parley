import path from 'node:path';
import { Counter, oneLine, tokenCount, type TokenTotals } from '../counters.js';
import { forEachJsonlRecord, type RawRecord } from '../jsonl.js';
import { INDEX_READ_CONCURRENCY, mapLimited } from '../map-limited.js';
import type { SessionIndex } from '../session-index.js';
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
 * Токены из записи `token_count`: `total_token_usage` — накопительный итог сессии,
 * поэтому берётся последняя такая запись, а не сумма.
 *
 * У Codex `input_tokens` включает в себя `cached_input_tokens`, поэтому кэш
 * вычитается: иначе четыре счётчика перестают складываться в общий итог, как
 * они складываются у Claude. Отдельного счётчика ЗАПИСИ в кэш у Codex нет —
 * `cacheWrite` всегда 0 (docs/schema/codex-schema-report.json).
 */
function codexTokens(payload: RawRecord): TokenTotals | null {
  const info = asRecord(payload['info']);
  const total = info === null ? null : asRecord(info['total_token_usage']);
  if (total === null) return null;

  const cacheRead = tokenCount(total, 'cached_input_tokens');
  return {
    input: Math.max(0, tokenCount(total, 'input_tokens') - cacheRead),
    output: tokenCount(total, 'output_tokens'),
    cacheRead,
    cacheWrite: 0,
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
  let lastTurnEvent: SessionIndex['lastTurnEvent'];
  let tokens: TokenTotals | null = null;
  let spawned = false;

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
        if (kind === 'token_count') tokens = codexTokens(payload) ?? tokens;
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
    provider: 'codex',
    ...(spawned ? { spawned: true } : {}),
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
