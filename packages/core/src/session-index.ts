import type { AgentPlan } from './agent-plan.js';
import { createClaudePlanCollector } from './agent-plan-log.js';
import path from 'node:path';
import { forEachJsonlRecord, type RawRecord } from './jsonl.js';
import { DEFAULT_TIMELINE_READER, readJsonlTail, type TailCursor, type TimelineReader } from './jsonl-tail.js';
import { adapterV1, type SchemaAdapter, type SessionRecord } from './adapter-v1.js';
import { Counter, oneLine, SYNTHETIC_MODEL, type TokenTotals } from './counters.js';
import type { DiscoveredSubagent } from './discover.js';
import { blocksText } from './feed/reduce.js';
import { isPointerText } from './work/delivery.js';
import { createUsageLedger, type UsageObservation, type UsageSummary, type UsageWindow } from './work/usage-ledger.js';
import { extendUsageTimeline, type UsageTimeline } from './work/usage-timeline.js';
import { claudeUsageObservation, noteClaudeSidechain, replayClaudeUsage, type ClaudeSidechain } from './work/usage-observations.js';
import { isRecord, textOf } from './work/events.js';

export type Provider = 'claude' | 'codex' | 'glm';

/**
 * Откуда взят заголовок: заданный пользователем, сгенерированный моделью,
 * последняя реплика или первая реплика пользователя.
 */
export type TitleSource = 'custom' | 'ai' | 'last-prompt' | 'first-text';

export interface SessionIndex {
  plan?: AgentPlan | null;
  /** sessionId из записей; если его нет — имя файла. */
  id: string;
  /** Слаг каталога проекта в ~/.claude/projects. */
  project: string;
  /** Абсолютный путь проекта (из cwd записей). */
  projectPath: string | null;
  cwd: string | null;
  gitBranch: string | null;
  version: string | null;
  file: string;
  /** Имя сессии для списка. null только у файла совсем без пригодных записей. */
  title: string | null;
  titleSource: TitleSource | null;
  startedAt: string | null;
  endedAt: string | null;
  /**
   * Время последней записи ПОЛЬЗОВАТЕЛЯ (у Claude Code это и реплика человека, и
   * результат инструмента). Ею страховка снимает `blocked`: пока агент ждёт
   * ответа, в транскрипт со стороны пользователя не пишется ничего, а как только
   * разрешение выдано — появляется запись (дизайн TUI v2, раздел 4.3).
   */
  lastUserRecordAt: string | null;
  /**
   * Время последней записи человека или ассистента (`message.role`). Служебные записи — итоги хуков
   * (`stop_hook_summary`), `turn_duration`, вложения — Claude Code дописывает и после конца хода: по общему
   * `endedAt` «страховка по логу» считала бы закончившую ход сессию работающей ещё порог тишины, а
   * письма ей всё это время ждали бы (живая проверка 2026-10-02).
   */
  lastWorkRecordAt: string | null;
  /** Последнее явное событие хода Codex; служебные записи после ответа его не меняют. */
  lastTurnEvent?: {
    type: 'task_started' | 'task_complete' | 'turn_aborted';
    at: string;
    /**
     * Только у `task_complete`, которым ход кончился ошибкой: `info` — её вид (`codex_error_info`: строка или
     * объект с полями, как в логе), `message` — текст ошибки (пустой, если лог его не назвал). Описывает только
     * это событие: следующее событие хода записывается без неё.
     */
    error?: { info: unknown; message: string };
  };
  /**
   * Самый ранний вызов code mode Codex (`exec` или `wait`) без вывода после последнего конца хода. `yieldMs` —
   * заявленное ожидание ячейки (`yield_time_ms`), `null` — не указано. Нет открытых вызовов — поля нет.
   */
  openCodeCall?: { name: 'exec' | 'wait'; at: string; yieldMs: number | null };
  /** Самая ранняя ячейка code mode с ответом «ещё выполняется», но без результата последующего wait. */
  pendingCodeCell?: { id: string; at: string };
  /**
   * Самая поздняя запись ассистента с ошибкой API (`isApiErrorMessage: true`; только Claude Code и GLM):
   * финальный отказ вроде лимита подписки, а не повтор запроса (`system/api_error`). `error` — поле `error`
   * записи (`rate_limit`, `authentication_failed`…; `null`, если его нет), `text` — текст блоков её
   * `message.content`. Успешный ответ после неё поле не снимает: сравнивает потребитель, по времени. Нет
   * поля — таких записей нет.
   */
  lastApiError?: { at: string; error: string | null; text: string };
  durationMs: number | null;
  records: number;
  malformedLines: number;
  models: Record<string, number>;
  tools: Record<string, number>;
  roles: Record<string, number>;
  recordTypes: Record<string, number>;
  /** Самая частая модель, кроме служебной `<synthetic>`. */
  primaryModel: string | null;
  /** Число подсессий: считается по раскладке каталогов, а не по содержимому файла. */
  subsessionCount: number;
  /**
   * Суммарные токены сессии по четырём счётчикам. `null`, если в логе нет ни одной
   * записи с usage: нулями это не заменяется, «не знаем» и «ноль» — разные вещи.
   */
  tokens: TokenTotals | null;
  /**
   * Те же токены с происхождением (P36): кэш и полный вход как наблюдения (`null` — не сообщено), время
   * последней записи, полнота. Источник истины для окна; `tokens` остаётся для прежних потребителей.
   * У Claude в итог входят подагенты из соседних файлов (`coverage` это показывает), а `tokens` — только
   * собственный лог. У Codex — только собственный лог треда: потомков по `parentId` складывает вызывающий
   * (`withDescendants`). Нет поля — индекс собран кодом до P36.
   */
  usage?: UsageSummary;
  provider: Provider;
  /**
   * Лог порождённого треда (только Codex): у `session_meta` задан `parent_thread_id` или `source` не
   * `cli` — подагент, внутренний тред или неинтерактивный запуск, а не сессия, которую запустил
   * человек или харнесс. К записи карты такой лог не привязывается (`linkProviderSession`). Нет поля —
   * тред обычный; у Claude его нет вовсе.
   */
  spawned?: boolean;
  /**
   * Нативный id родительского треда (только Codex): `parent_thread_id` порождённого треда. По нему
   * потомок находится у родителя; к записи карты порождённый тред не привязывается. Нет поля — родителя нет.
   */
  parentId?: string;
  /**
   * Нативный id треда, чью историю этот тред унаследовал при форке (только Codex: `forked_from_id`).
   * Базу унаследованного не отделить, поэтому перекрытие с родителем не разрешено (`overlapUnresolved`).
   */
  forkedFrom?: string;
  /**
   * Первая реплика пользователя в логе — указатель Parley на письма (`isPointerText`): разговор начал не человек,
   * а доставка почты агенту комнаты, запущенному без задачи. Заголовки из такого начала — сам указатель или
   * `ai-title`, сгенерированный по нему, — не имя сессии (`autoTitleOf`). Нет поля — начало обычное.
   */
  firstPromptPointer?: true;
}

/**
 * Служебный текст Claude Code в реплике с ролью `user`: обёртки слеш-команды (`<command-name>`,
 * `<command-message>`, `<command-args>`), её вывод (`<local-command-stdout>`, `<local-command-caveat>`…)
 * и режима `!` (`<bash-input>`, `<bash-stdout>`…). Это не запрос человека: ни заголовком сессии, ни её
 * ярлыком он быть не может.
 */
export function isServiceText(text: string): boolean {
  return /^\s*<(?:command|local-command|bash)-[a-z-]+>/.test(text);
}

/**
 * Слеш-команда (`/model opus`, `/oh-my-claudecode:cancel`) или режим `!` (`!ls`) в запросе: не запрос
 * человека, заголовком быть не может. Путь в начале запроса (`/Users/me/app.ts …`) — не команда.
 */
function isCommandPrompt(text: string): boolean {
  return /^\s*(?:\/[A-Za-z][\w:-]*(?:\s|$)|!)/.test(text);
}

/** Слаг проекта = первый сегмент пути относительно корня ~/.claude/projects. */
export function projectSlug(file: string, root: string): string {
  const relative = path.relative(root, file);
  const [first] = relative.split(path.sep);
  return first && first !== '..' ? first : path.basename(path.dirname(file));
}

export interface IndexSessionOptions {
  adapter?: SchemaAdapter;
  /**
   * Файлы подагентов (вызывающий обошёл <session-id>/subagents/): их токены входят в `usage`, число —
   * в `subsessionCount`. Не заданы — учёт только собственного лога.
   */
  subagents?: DiscoveredSubagent[];
  /** Число подсессий, если известно без чтения файлов; по умолчанию — число `subagents`. */
  subsessionCount?: number;
  /** Прерывает чтение файла: промис отклоняется `AbortError` (`forEachJsonlRecord`). */
  signal?: AbortSignal;
  /**
   * Окна среза учёта (спека расхода токенов, 5.3): в `usage` (и в `tokens`) только записи из них. Нет — весь лог.
   * Вызывающий со срезом берёт из индекса только `usage`.
   */
  usageWindows?: readonly UsageWindow[];
}

/** Подагент для итога: id агента и его наблюдения учёта (`replayClaudeUsage`). */
interface SubagentObservations {
  agentId: string | null;
  observations: readonly UsageObservation[];
}

/**
 * Состояние накопления индекса одного файла сессии Claude: пустое → `feed` по записи → `build` собирает
 * SessionIndex. Полное чтение (`indexSessionFile`) и дочитывание хвоста (`extendClaudeSessionIndex`) идут
 * через одно и то же, поэтому результат у них совпадает.
 */
export class ClaudeIndexAccumulator {
  planCollector = createClaudePlanCollector();
  models = new Counter();
  tools = new Counter();
  roles = new Counter();
  recordTypes = new Counter();
  // Наблюдения копятся и проигрываются в ledger в конце (usage-observations): один ответ модели приходит
  // несколькими записями, склейка по message.id — в учёте токенов.
  observations: UsageObservation[] = [];
  sidechain: ClaudeSidechain = { agents: new Set(), unidentified: false };

  sessionId: string | null = null;
  cwd: string | null = null;
  gitBranch: string | null = null;
  version: string | null = null;
  startedAt: string | null = null;
  endedAt: string | null = null;
  lastUserRecordAt: string | null = null;
  lastWorkRecordAt: string | null = null;
  lastApiError: SessionIndex['lastApiError'];

  // Заголовки дописываются в файл снова и снова — побеждает последний.
  title: string | null = null;
  titleSource: TitleSource | null = null;
  lastPrompt: string | null = null;
  firstText: string | null = null;

  /** Записей-объектов и битых строк среди принятых целыми строками. */
  parsed = 0;
  malformed = 0;

  constructor(
    readonly file: string,
    readonly adapter: SchemaAdapter = adapterV1,
  ) {}

  /** Независимая копия: счётчики и наблюдения копируются, прежнее состояние не мутируется. */
  clone(): ClaudeIndexAccumulator {
    return Object.assign(new ClaudeIndexAccumulator(this.file, this.adapter), this, {
      planCollector: this.planCollector.clone(),
      models: this.models.clone(),
      tools: this.tools.clone(),
      roles: this.roles.clone(),
      recordTypes: this.recordTypes.clone(),
      observations: [...this.observations],
      sidechain: { agents: new Set(this.sidechain.agents), unidentified: this.sidechain.unidentified },
    });
  }

  feed(raw: RawRecord, lineNo: number): void {
    this.planCollector.onRecord(raw);
    const record: SessionRecord = this.adapter.toSessionRecord(raw);

    this.recordTypes.add(record.type);
    this.models.add(record.model);
    this.roles.add(record.role);
    for (const tool of record.toolUses) this.tools.add(tool);

    const observation = claudeUsageObservation(record, this.file, lineNo);
    if (observation !== null) {
      this.observations.push(observation);
      noteClaudeSidechain(this.sidechain, record);
    }

    this.sessionId ??= record.sessionId;
    this.cwd ??= record.cwd;
    this.gitBranch ??= record.gitBranch;
    this.version ??= record.version;

    if (record.title !== null && (record.type === 'custom-title' || record.type === 'ai-title')) {
      this.title = record.title;
      this.titleSource = record.type === 'custom-title' ? 'custom' : 'ai';
    }
    // Последний запрос-команда (`/model`, `!ls`) или служебный текст не заменяет прежний настоящий.
    if (
      record.lastPrompt !== null &&
      !isServiceText(record.lastPrompt) &&
      !isCommandPrompt(record.lastPrompt)
    ) {
      this.lastPrompt = record.lastPrompt;
    }
    // Служебные реплики (`isMeta`, обёртки слеш-команд) — не первая реплика человека: сессия, начатая
    // с `/model`, иначе называлась бы `<local-command-caveat>…`.
    if (
      this.firstText === null &&
      record.role === 'user' &&
      record.text !== null &&
      !record.isMeta &&
      !isServiceText(record.text)
    ) {
      this.firstText = record.text;
    }

    // Записи заголовков и служебные идут без timestamp — по ним время не считаем.
    const at = record.timestamp;
    if (at !== null) {
      if (this.startedAt === null || at < this.startedAt) this.startedAt = at;
      if (this.endedAt === null || at > this.endedAt) this.endedAt = at;
      if (record.role === 'user' && (this.lastUserRecordAt === null || at > this.lastUserRecordAt)) {
        this.lastUserRecordAt = at;
      }
      if (record.role !== null && (this.lastWorkRecordAt === null || at > this.lastWorkRecordAt)) {
        this.lastWorkRecordAt = at;
      }
      // Финальную ошибку API (лимит, вход, оплата) Claude Code пишет синтетическим ответом ассистента с
      // отметкой; повторы запроса (`system/api_error`) её не несут. Побеждает запись с самым поздним
      // временем — как у осей выше.
      if (
        record.role === 'assistant' &&
        raw['isApiErrorMessage'] === true &&
        (this.lastApiError === undefined || at >= this.lastApiError.at)
      ) {
        const message = raw['message'];
        this.lastApiError = {
          at,
          error: textOf(raw['error']),
          // Текст блоков ответа, как у карточки ошибки ленты (`feedFromTranscript`); текста нет — `''`.
          text: blocksText(isRecord(message) ? message['content'] : null) ?? '',
        };
      }
    }
  }

  /**
   * Собирает SessionIndex. `pendingMalformed` — оборванная последняя строка: полное чтение считает её битой,
   * хотя в состояние она ещё не вошла.
   */
  build(
    root: string,
    {
      subagents = [],
      subsessionCount = subagents.length,
      usageWindows,
      pendingMalformed = false,
    }: {
      subagents?: readonly SubagentObservations[];
      subsessionCount?: number;
      usageWindows?: readonly UsageWindow[];
      pendingMalformed?: boolean;
    } = {},
  ): SessionIndex {
    const { file, observations, sidechain, startedAt, endedAt, firstText } = this;
    const durationMs =
      startedAt !== null && endedAt !== null
        ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt))
        : null;

    // Заголовка нет — показываем реплику: сначала последнюю, потом первую.
    let title = this.title;
    let titleSource = this.titleSource;
    if (title === null && this.lastPrompt !== null) {
      title = oneLine(this.lastPrompt);
      titleSource = 'last-prompt';
    }
    if (title === null && firstText !== null) {
      title = oneLine(firstText);
      titleSource = 'first-text';
    }

    // `tokens` и `usage` собственного лога снимаются до подагентов: прежние потребители ждут его одного.
    const usageOptions = usageWindows === undefined ? {} : { windows: usageWindows };
    const ownLedger = createUsageLedger(usageOptions);
    replayClaudeUsage(ownLedger, { observations, sidechain }, []);
    const own = ownLedger.summary();
    let usage = own;
    if (subagents.length > 0) {
      const ledger = createUsageLedger(usageOptions);
      replayClaudeUsage(ledger, { observations, sidechain }, subagents);
      usage = ledger.summary();
    }
    // `tokens` — для показа (лента, строка метрик): неизвестное поле показывается нулём, а в `usage` остаётся null.
    const tokens: TokenTotals | null = observations.length > 0
      ? {
          input: own.input ?? 0,
          output: own.output ?? 0,
          cacheRead: own.cacheRead ?? 0,
          cacheWrite: own.cacheWrite ?? 0,
        }
      : null;

    return {
      plan: this.planCollector.finish(),
      id: this.sessionId ?? path.basename(file, '.jsonl'),
      project: projectSlug(file, root),
      projectPath: this.cwd,
      cwd: this.cwd,
      gitBranch: this.gitBranch,
      version: this.version,
      file,
      title,
      titleSource,
      startedAt,
      endedAt,
      lastUserRecordAt: this.lastUserRecordAt,
      lastWorkRecordAt: this.lastWorkRecordAt,
      ...(this.lastApiError === undefined ? {} : { lastApiError: this.lastApiError }),
      durationMs,
      records: this.parsed,
      malformedLines: this.malformed + (pendingMalformed ? 1 : 0),
      models: this.models.toObject(),
      tools: this.tools.toObject(),
      roles: this.roles.toObject(),
      recordTypes: this.recordTypes.toObject(),
      primaryModel: this.models.top(new Set([SYNTHETIC_MODEL])),
      subsessionCount,
      tokens,
      usage,
      provider: 'claude',
      ...(firstText !== null && isPointerText(firstText) ? { firstPromptPointer: true as const } : {}),
    };
  }
}

/**
 * Индексирует ОДИН файл сессии: мета, заголовок, длительность, счётчики моделей,
 * инструментов, ролей и типов записей. Подсессии добавляются отдельно — они лежат
 * в соседних файлах, а не в этом (см. specs/data-layer.md).
 */
export async function indexSessionFile(
  file: string,
  root: string,
  { adapter = adapterV1, subagents = [], subsessionCount = subagents.length, signal, usageWindows }: IndexSessionOptions = {},
): Promise<SessionIndex> {
  const acc = new ClaudeIndexAccumulator(file, adapter);
  const stats = await forEachJsonlRecord(file, (raw, lineNo) => acc.feed(raw, lineNo), signal);
  acc.parsed = stats.parsed;
  acc.malformed = stats.malformed;

  const subagentObservations: SubagentObservations[] = [];
  for (const subagent of subagents) {
    const list: UsageObservation[] = [];
    await forEachJsonlRecord(subagent.file, (raw, lineNo) => {
      const observation = claudeUsageObservation(adapter.toSessionRecord(raw), subagent.file, lineNo);
      if (observation !== null) list.push(observation);
    }, signal);
    subagentObservations.push({ agentId: subagent.agentId, observations: list });
  }
  return acc.build(root, { subagents: subagentObservations, subsessionCount, ...(usageWindows === undefined ? {} : { usageWindows }) });
}

/** Состояние дочитывания сессии Claude: накопленное, место в главном файле и шкалы подагентов по пути файла. */
export interface ClaudeIndexState {
  acc: ClaudeIndexAccumulator;
  cursor: TailCursor;
  subagents: ReadonlyMap<string, UsageTimeline>;
}

export interface ExtendClaudeOptions {
  adapter?: SchemaAdapter;
  /** Как у `IndexSessionOptions`: подагенты входят в `usage` и `subsessionCount`. Пропавший из списка выпадает. */
  subagents?: DiscoveredSubagent[];
  subsessionCount?: number;
  reader?: TimelineReader;
}

/** Ошибка «файла нет» в форме, которую ждут вызывающие полного чтения. */
export function missingFileError(file: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: no such file or directory, open '${file}'`), { code: 'ENOENT' });
}

/**
 * То же, что `indexSessionFile`, но дочитывает только дописанное с места `previous` (ноль байт — файл не
 * открывается). Возвращает НОВОЕ состояние (прежнее не меняется) и SessionIndex, равный полному чтению
 * текущего содержимого, включая момент, когда последняя строка оборвана. Подагенты — хвостом через
 * `extendUsageTimeline`. Файла нет — ошибка ENOENT, как у полного чтения.
 */
export async function extendClaudeSessionIndex(
  previous: ClaudeIndexState | null,
  file: string,
  root: string,
  { adapter = adapterV1, subagents = [], subsessionCount = subagents.length, reader = DEFAULT_TIMELINE_READER }: ExtendClaudeOptions = {},
): Promise<{ state: ClaudeIndexState; index: SessionIndex }> {
  let draft: ClaudeIndexAccumulator | null = null;
  const result = await readJsonlTail(previous?.cursor ?? null, file, reader, {
    reset: () => {
      draft = new ClaudeIndexAccumulator(file, adapter);
    },
    record: (raw, lineNo) => {
      draft ??= (previous as ClaudeIndexState).acc.clone();
      draft.feed(raw, lineNo);
    },
  });
  if (result.missing) throw missingFileError(file);

  // Счётчики строк входят в состояние, только если появились целые строки; прежнее не трогаем.
  let acc = (draft as ClaudeIndexAccumulator | null) ?? (previous as ClaudeIndexState).acc;
  if (result.parsed > 0 || result.malformed > 0) {
    if (acc === (previous as ClaudeIndexState | null)?.acc) acc = acc.clone();
    acc.parsed += result.parsed;
    acc.malformed += result.malformed;
  }

  const timelines = new Map<string, UsageTimeline>();
  const subagentObservations: SubagentObservations[] = [];
  for (const subagent of subagents) {
    const timeline = await extendUsageTimeline(previous?.subagents.get(subagent.file) ?? null, subagent.file, 'claude', reader, adapter);
    timelines.set(subagent.file, timeline);
    subagentObservations.push({ agentId: subagent.agentId, observations: timeline.observations });
  }

  const index = acc.build(root, {
    subagents: subagentObservations,
    subsessionCount,
    pendingMalformed: result.cursor.pendingMalformed,
  });
  return { state: { acc, cursor: result.cursor, subagents: timelines }, index };
}
