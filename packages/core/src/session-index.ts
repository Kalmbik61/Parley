import path from 'node:path';
import { forEachJsonlRecord, type RawRecord } from './jsonl.js';
import { adapterV1, type SchemaAdapter, type SessionRecord } from './adapter-v1.js';
import { Counter, oneLine, SYNTHETIC_MODEL, type TokenTotals } from './counters.js';
import type { DiscoveredSubagent } from './discover.js';
import { isPointerText } from './work/delivery.js';
import { createUsageLedger, type UsageObservation, type UsageSummary, type UsageWindow } from './work/usage-ledger.js';
import { claudeUsageObservation, noteClaudeSidechain, replayClaudeUsage, type ClaudeSidechain } from './work/usage-observations.js';

export type Provider = 'claude' | 'codex' | 'glm';

/**
 * Откуда взят заголовок: заданный пользователем, сгенерированный моделью,
 * последняя реплика или первая реплика пользователя.
 */
export type TitleSource = 'custom' | 'ai' | 'last-prompt' | 'first-text';

export interface SessionIndex {
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
  };
  /**
   * Самый ранний вызов code mode Codex (`exec` или `wait`) без вывода после последнего конца хода. `yieldMs` —
   * заявленное ожидание ячейки (`yield_time_ms`), `null` — не указано. Нет открытых вызовов — поля нет.
   */
  openCodeCall?: { name: 'exec' | 'wait'; at: string; yieldMs: number | null };
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
  const models = new Counter();
  const tools = new Counter();
  const roles = new Counter();
  const recordTypes = new Counter();
  // Наблюдения копятся и проигрываются в ledger в конце (usage-observations): один ответ модели приходит
  // несколькими записями, склейка по message.id — в учёте токенов.
  const observations: UsageObservation[] = [];
  const sidechain: ClaudeSidechain = { agents: new Set(), unidentified: false };

  let sessionId: string | null = null;
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let version: string | null = null;
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  let lastUserRecordAt: string | null = null;
  let lastWorkRecordAt: string | null = null;

  // Заголовки дописываются в файл снова и снова — побеждает последний.
  let title: string | null = null;
  let titleSource: TitleSource | null = null;
  let lastPrompt: string | null = null;
  let firstText: string | null = null;

  const onRecord = (raw: RawRecord, lineNo: number): void => {
    const record: SessionRecord = adapter.toSessionRecord(raw);

    recordTypes.add(record.type);
    models.add(record.model);
    roles.add(record.role);
    for (const tool of record.toolUses) tools.add(tool);

    const observation = claudeUsageObservation(record, file, lineNo);
    if (observation !== null) {
      observations.push(observation);
      noteClaudeSidechain(sidechain, record);
    }

    sessionId ??= record.sessionId;
    cwd ??= record.cwd;
    gitBranch ??= record.gitBranch;
    version ??= record.version;

    if (record.title !== null && (record.type === 'custom-title' || record.type === 'ai-title')) {
      title = record.title;
      titleSource = record.type === 'custom-title' ? 'custom' : 'ai';
    }
    // Последний запрос-команда (`/model`, `!ls`) или служебный текст не заменяет прежний настоящий.
    if (
      record.lastPrompt !== null &&
      !isServiceText(record.lastPrompt) &&
      !isCommandPrompt(record.lastPrompt)
    ) {
      lastPrompt = record.lastPrompt;
    }
    // Служебные реплики (`isMeta`, обёртки слеш-команд) — не первая реплика человека: сессия, начатая
    // с `/model`, иначе называлась бы `<local-command-caveat>…`.
    if (
      firstText === null &&
      record.role === 'user' &&
      record.text !== null &&
      !record.isMeta &&
      !isServiceText(record.text)
    ) {
      firstText = record.text;
    }

    // Записи заголовков и служебные идут без timestamp — по ним время не считаем.
    const at = record.timestamp;
    if (at !== null) {
      if (startedAt === null || at < startedAt) startedAt = at;
      if (endedAt === null || at > endedAt) endedAt = at;
      if (record.role === 'user' && (lastUserRecordAt === null || at > lastUserRecordAt)) {
        lastUserRecordAt = at;
      }
      if (record.role !== null && (lastWorkRecordAt === null || at > lastWorkRecordAt)) {
        lastWorkRecordAt = at;
      }
    }
  };
  const stats = await forEachJsonlRecord(file, onRecord, signal);

  const durationMs =
    startedAt !== null && endedAt !== null
      ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt))
      : null;

  // Заголовка нет — показываем реплику: сначала последнюю, потом первую.
  if (title === null && lastPrompt !== null) {
    title = oneLine(lastPrompt);
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
  const subagentObservations: Array<{ agentId: string; observations: UsageObservation[] }> = [];
  for (const subagent of subagents) {
    const list: UsageObservation[] = [];
    await forEachJsonlRecord(subagent.file, (raw, lineNo) => {
      const observation = claudeUsageObservation(adapter.toSessionRecord(raw), subagent.file, lineNo);
      if (observation !== null) list.push(observation);
    }, signal);
    subagentObservations.push({ agentId: subagent.agentId, observations: list });
  }
  let usage = own;
  if (subagentObservations.length > 0) {
    const ledger = createUsageLedger(usageOptions);
    replayClaudeUsage(ledger, { observations, sidechain }, subagentObservations);
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
    id: sessionId ?? path.basename(file, '.jsonl'),
    project: projectSlug(file, root),
    projectPath: cwd,
    cwd,
    gitBranch,
    version,
    file,
    title,
    titleSource,
    startedAt,
    endedAt,
    lastUserRecordAt,
    lastWorkRecordAt,
    durationMs,
    records: stats.parsed,
    malformedLines: stats.malformed,
    models: models.toObject(),
    tools: tools.toObject(),
    roles: roles.toObject(),
    recordTypes: recordTypes.toObject(),
    primaryModel: models.top(new Set([SYNTHETIC_MODEL])),
    subsessionCount,
    tokens,
    usage,
    provider: 'claude',
    ...(firstText !== null && isPointerText(firstText) ? { firstPromptPointer: true as const } : {}),
  };
}
