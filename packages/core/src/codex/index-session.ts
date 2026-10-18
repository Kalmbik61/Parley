import { createCodexPlanCollector } from '../agent-plan-log.js';
import path from 'node:path';
import { Counter, oneLine, type TokenTotals } from '../counters.js';
import { forEachJsonlRecord, type RawRecord } from '../jsonl.js';
import { DEFAULT_TIMELINE_READER, readJsonlTail, type TailCursor, type TimelineReader } from '../jsonl-tail.js';
import { INDEX_READ_CONCURRENCY, mapLimited } from '../map-limited.js';
import { missingFileError, type SessionIndex } from '../session-index.js';
import { isPointerText } from '../work/delivery.js';
import { createUsageLedger, type UsageCounters, type UsageObservation, type UsageWindow } from '../work/usage-ledger.js';
import { codexUsageObservation } from '../work/usage-observations.js';
import { assistantCwd } from '../discover.js';
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

/** Ожидание ячейки `exec` — `yield_time_ms` из прагмы `// @exec: {...}` в первой строке кода; иначе null. */
function execYieldMs(input: string | null): number | null {
  const first = input?.split('\n', 1)[0]?.trim() ?? '';
  const match = /^\/\/\s*@exec:\s*(\{.*\})\s*$/.exec(first);
  if (match?.[1] === undefined) return null;
  try {
    const value = asRecord(JSON.parse(match[1]))?.['yield_time_ms'];
    return typeof value === 'number' ? value : null;
  } catch {
    return null;
  }
}

/** Аргументы `wait`: срок ожидания и ячейка, чей результат он возвращает. */
function waitArguments(args: string | null): RawRecord | null {
  if (args === null) return null;
  try {
    return asRecord(JSON.parse(args));
  } catch {
    return null;
  }
}

/**
 * Состояние накопления индекса одного rollout-лога Codex: пустое → `feed` по записи → `build` собирает
 * SessionIndex. Полное чтение (`indexCodexSession`) и дочитывание хвоста (`extendCodexSessionIndex`) идут
 * через одно и то же, поэтому результат у них совпадает.
 */
export class CodexIndexAccumulator {
  planCollector = createCodexPlanCollector();
  models = new Counter();
  tools = new Counter();
  roles = new Counter();
  recordTypes = new Counter();

  id: string | null = null;
  cwd: string | null = null;
  gitBranch: string | null = null;
  version: string | null = null;
  startedAt: string | null = null;
  endedAt: string | null = null;
  firstUserMessage: string | null = null;
  lastUserRecordAt: string | null = null;
  lastCounters = null as UsageCounters | null;
  // Наблюдения копятся и проигрываются в ledger при сборке: сам ledger копировать нельзя.
  observations: UsageObservation[] = [];
  lastTurnEvent: SessionIndex['lastTurnEvent'];
  // Открытые вызовы code mode по call_id (разбор 2026-10-16).
  openCalls = new Map<string, { name: 'exec' | 'wait'; at: string; yieldMs: number | null; cellId: string | null; active: boolean }>();
  runningCells = new Map<string, { id: string; at: string }>();
  spawned = false;
  parentId: string | null = null;
  forkedFrom: string | null = null;

  /** Записей-объектов и битых строк среди принятых целыми строками. */
  parsed = 0;
  malformed = 0;

  /** Независимая копия: счётчики, наблюдения и открытые вызовы копируются, прежнее состояние не мутируется. */
  clone(): CodexIndexAccumulator {
    return Object.assign(new CodexIndexAccumulator(), this, {
      planCollector: this.planCollector.clone(),
      models: this.models.clone(),
      tools: this.tools.clone(),
      roles: this.roles.clone(),
      recordTypes: this.recordTypes.clone(),
      observations: [...this.observations],
      openCalls: new Map(this.openCalls),
      runningCells: new Map(this.runningCells),
    });
  }

  feed(raw: RawRecord): void {
    this.planCollector.onRecord(raw);
    const type = str(raw, 'type');
    const payload = asRecord(raw['payload']);
    this.recordTypes.add(type);

    const at = str(raw, 'timestamp');
    if (at !== null) {
      if (this.startedAt === null || at < this.startedAt) this.startedAt = at;
      if (this.endedAt === null || at > this.endedAt) this.endedAt = at;
    }

    if (payload === null) return;
    const kind = str(payload, 'type');

    switch (type) {
      case 'session_meta': {
        this.id ??= str(payload, 'id');
        this.cwd ??= str(payload, 'cwd');
        this.version ??= str(payload, 'cli_version');
        this.gitBranch ??= str(asRecord(payload['git']), 'branch');
        this.spawned ||= isSpawnedMeta(payload);
        this.parentId ??= parentThreadId(payload);
        this.forkedFrom ??= str(payload, 'forked_from_id');
        break;
      }

      case 'turn_context': {
        // Модель меняется между ходами — считаем каждый ход.
        this.models.add(str(payload, 'model'));
        this.cwd ??= str(payload, 'cwd');
        break;
      }

      case 'response_item': {
        if (kind === 'message') this.roles.add(str(payload, 'role'));
        // Инструменты вызываются и обычные, и «кастомные» — считаем оба вида.
        if (kind === 'function_call' || kind === 'custom_tool_call') {
          this.tools.add(str(payload, 'name'));
        }
        const callId = str(payload, 'call_id');
        if (callId !== null && at !== null) {
          const name = str(payload, 'name');
          if (kind === 'custom_tool_call' && name === 'exec') {
            this.openCalls.set(callId, { name: 'exec', at, yieldMs: execYieldMs(str(payload, 'input')), cellId: null, active: true });
          } else if (kind === 'function_call' && name === 'wait') {
            const args = waitArguments(str(payload, 'arguments'));
            const yieldMs = args?.['yield_time_ms'];
            this.openCalls.set(callId, { name: 'wait', at, yieldMs: typeof yieldMs === 'number' ? yieldMs : null, cellId: str(args, 'cell_id'), active: true });
          } else if (kind === 'custom_tool_call_output' || kind === 'function_call_output') {
            const call = this.openCalls.get(callId);
            if (call !== undefined) {
              const output = payload['output'];
              // Только заголовок ответа обёртки: текст вложенной команды не задаёт состояние ячейки.
              const text = typeof output === 'string' ? output : Array.isArray(output) ? str(asRecord(output[0]), 'text') : null;
              const runningId = /^Script running with cell ID ([A-Za-z0-9_-]+)(?:\r?\n|$)/.exec(text ?? '')?.[1];
              if (runningId !== undefined && !this.runningCells.has(runningId)) {
                this.runningCells.set(runningId, { id: runningId, at: call.at });
              } else if (call.cellId !== null && /^Script (?:completed|terminated)\b/.test(text ?? '')) {
                this.runningCells.delete(call.cellId);
              }
            }
            this.openCalls.delete(callId);
          }
        }
        break;
      }

      case 'event_msg': {
        if (
          at !== null &&
          (kind === 'task_started' || kind === 'task_complete' || kind === 'turn_aborted')
        ) {
          this.lastTurnEvent = { type: kind, at };
        }
        // После конца хода вызов не сторожится, но его поздний ответ ещё может завершить ячейку.
        // Значения заменяются, чтобы дочитывание не мутировало предыдущий снимок накопителя.
        if (kind === 'task_complete') {
          for (const [id, call] of this.openCalls) this.openCalls.set(id, { ...call, active: false });
        }
        // Явное прерывание снимает предупреждение; это не подтверждение отмены внешних эффектов команды.
        if (kind === 'turn_aborted') {
          this.openCalls.clear();
          this.runningCells.clear();
        }
        // Заголовок сессии — первая РЕПЛИКА ЧЕЛОВЕКА. Сообщения из response_item
        // для этого не годятся: там же едут системные инструкции и AGENTS.md.
        if (kind === 'user_message') {
          this.firstUserMessage ??= str(payload, 'message') ?? firstContentText(payload);
          // Результаты инструментов у Codex едут не сообщениями пользователя, так
          // что отметка страховки здесь — ровно реплика человека (раздел 4.3).
          if (at !== null && (this.lastUserRecordAt === null || at > this.lastUserRecordAt)) {
            this.lastUserRecordAt = at;
          }
        }
        const observation = codexUsageObservation(raw);
        if (observation !== null) {
          this.lastCounters = observation.counters;
          this.observations.push(observation);
        }
        break;
      }

      default:
        break;
    }
  }

  /**
   * Собирает SessionIndex. `pendingMalformed` — оборванная последняя строка: полное чтение считает её битой,
   * хотя в состояние она ещё не вошла.
   */
  build(
    file: string,
    { usageWindows, pendingMalformed = false }: { usageWindows?: readonly UsageWindow[]; pendingMalformed?: boolean } = {},
  ): SessionIndex {
    const { cwd, startedAt, endedAt, lastCounters, firstUserMessage, lastTurnEvent, spawned, parentId, forkedFrom } = this;
    const ledger = createUsageLedger(usageWindows === undefined ? {} : { windows: usageWindows });
    for (const observation of this.observations) ledger.observe(observation);

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

    let openCodeCall: SessionIndex['openCodeCall'];
    for (const call of this.openCalls.values()) {
      if (!call.active) continue;
      if (openCodeCall === undefined || call.at < openCodeCall.at) {
        openCodeCall = { name: call.name, at: call.at, yieldMs: call.yieldMs };
      }
    }

    let pendingCodeCell: SessionIndex['pendingCodeCell'];
    for (const cell of this.runningCells.values()) {
      if (pendingCodeCell === undefined || cell.at < pendingCodeCell.at) pendingCodeCell = cell;
    }

    const title = firstUserMessage === null ? null : oneLine(firstUserMessage);

    return {
      plan: this.planCollector.finish(),
      id: this.id ?? path.basename(file, '.jsonl'),
      // Слага проекта у Codex нет — берём имя каталога из cwd.
      project: cwd === null ? '—' : path.basename(cwd),
      projectPath: cwd,
      cwd,
      gitBranch: this.gitBranch,
      version: this.version,
      file,
      title,
      titleSource: title === null ? null : 'first-text',
      startedAt,
      endedAt,
      lastUserRecordAt: this.lastUserRecordAt,
      // У Codex служебного хвоста после хода нет в этом смысле: время работы — время последней записи.
      lastWorkRecordAt: endedAt,
      ...(lastTurnEvent === undefined ? {} : { lastTurnEvent }),
      ...(openCodeCall === undefined ? {} : { openCodeCall }),
      ...(pendingCodeCell === undefined ? {} : { pendingCodeCell }),
      durationMs,
      records: this.parsed,
      malformedLines: this.malformed + (pendingMalformed ? 1 : 0),
      models: this.models.toObject(),
      tools: this.tools.toObject(),
      roles: this.roles.toObject(),
      recordTypes: this.recordTypes.toObject(),
      primaryModel: this.models.top(),
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
}

/**
 * Индексирует один rollout-лог Codex в общую модель SessionIndex.
 *
 * Формат другой во всём (см. specs/runners.md): вся мета в одной записи
 * `session_meta`, модель в `turn_context`, инструменты в `function_call`.
 * Наружу при этом отдаётся ровно тот же SessionIndex, что и у Claude Code, —
 * UI о различиях не знает. `signal` прерывает чтение (`forEachJsonlRecord`).
 */
export async function indexCodexSession(
  file: string,
  signal?: AbortSignal,
  options: { usageWindows?: readonly UsageWindow[] } = {},
): Promise<SessionIndex> {
  const acc = new CodexIndexAccumulator();
  const stats = await forEachJsonlRecord(file, (raw) => acc.feed(raw), signal);
  acc.parsed = stats.parsed;
  acc.malformed = stats.malformed;
  return acc.build(file, options.usageWindows === undefined ? {} : { usageWindows: options.usageWindows });
}

/** Состояние дочитывания rollout-лога Codex: накопленное и место в файле. */
export interface CodexIndexState {
  acc: CodexIndexAccumulator;
  cursor: TailCursor;
}

/**
 * То же, что `indexCodexSession`, но дочитывает только дописанное с места `previous` (нет новых байт — файл не
 * открывается). Возвращает НОВОЕ состояние (прежнее не меняется) и SessionIndex, равный полному чтению текущего
 * содержимого, включая момент, когда последняя строка оборвана. Файла нет — ошибка ENOENT, как у полного чтения.
 */
export async function extendCodexSessionIndex(
  previous: CodexIndexState | null,
  file: string,
  { reader = DEFAULT_TIMELINE_READER, usageWindows }: { reader?: TimelineReader; usageWindows?: readonly UsageWindow[] } = {},
): Promise<{ state: CodexIndexState; index: SessionIndex }> {
  let draft: CodexIndexAccumulator | null = null;
  const result = await readJsonlTail(previous?.cursor ?? null, file, reader, {
    reset: () => {
      draft = new CodexIndexAccumulator();
    },
    record: (raw) => {
      draft ??= (previous as CodexIndexState).acc.clone();
      draft.feed(raw);
    },
  });
  if (result.missing) throw missingFileError(file);

  // Счётчики строк входят в состояние, только если появились целые строки; прежнее не трогаем.
  let acc = (draft as CodexIndexAccumulator | null) ?? (previous as CodexIndexState).acc;
  if (result.parsed > 0 || result.malformed > 0) {
    if (acc === (previous as CodexIndexState | null)?.acc) acc = acc.clone();
    acc.parsed += result.parsed;
    acc.malformed += result.malformed;
  }
  const index = acc.build(file, {
    pendingMalformed: result.cursor.pendingMalformed,
    ...(usageWindows === undefined ? {} : { usageWindows }),
  });
  return { state: { acc, cursor: result.cursor }, index };
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
  const own = index.filter((session) => session.cwd !== assistantCwd());
  own.sort((a, b) => String(b.endedAt ?? '').localeCompare(String(a.endedAt ?? '')));
  return own;
}
