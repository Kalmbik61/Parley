import path from 'node:path';
import { forEachJsonlRecord } from './jsonl.js';
import { adapterV1, type SchemaAdapter, type SessionRecord } from './adapter-v1.js';
import { Counter, oneLine, SYNTHETIC_MODEL, type TokenTotals } from './counters.js';

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
  provider: Provider;
  /**
   * Лог порождённого треда (только Codex): у `session_meta` задан `parent_thread_id` или `source` не
   * `cli` — подагент, внутренний тред или неинтерактивный запуск, а не сессия, которую запустил
   * человек или харнесс. К записи карты такой лог не привязывается (`linkProviderSession`). Нет поля —
   * тред обычный; у Claude его нет вовсе.
   */
  spawned?: boolean;
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
  /** Известно только вызывающему, который обошёл <session-id>/subagents/. */
  subsessionCount?: number;
}

/**
 * Индексирует ОДИН файл сессии: мета, заголовок, длительность, счётчики моделей,
 * инструментов, ролей и типов записей. Подсессии добавляются отдельно — они лежат
 * в соседних файлах, а не в этом (см. specs/data-layer.md).
 */
export async function indexSessionFile(
  file: string,
  root: string,
  { adapter = adapterV1, subsessionCount = 0 }: IndexSessionOptions = {},
): Promise<SessionIndex> {
  const models = new Counter();
  const tools = new Counter();
  const roles = new Counter();
  const recordTypes = new Counter();
  const tokens: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  // Уже посчитанные ответы модели: один ответ приходит несколькими записями.
  const countedMessages = new Set<string>();
  let hasUsage = false;

  let sessionId: string | null = null;
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let version: string | null = null;
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  let lastUserRecordAt: string | null = null;

  // Заголовки дописываются в файл снова и снова — побеждает последний.
  let title: string | null = null;
  let titleSource: TitleSource | null = null;
  let lastPrompt: string | null = null;
  let firstText: string | null = null;

  const stats = await forEachJsonlRecord(file, (raw) => {
    const record: SessionRecord = adapter.toSessionRecord(raw);

    recordTypes.add(record.type);
    models.add(record.model);
    roles.add(record.role);
    for (const tool of record.toolUses) tools.add(tool);

    // Токены считаются только по ответам модели: usage в реплике человека —
    // это отчёт об уже учтённом вызове инструмента, повторный счёт.
    //
    // Второй источник двойного счёта крупнее: один ответ модели Claude Code
    // пишет несколькими записями — по одной на блок content (thinking, text,
    // tool_use), и КАЖДАЯ несёт полный usage всего ответа. Поэтому счёт идёт
    // по message.id, а не по записям (на реальных логах разница в 2–3 раза).
    // У записей без message.id склеивать не по чему — они считаются как есть.
    const messageId = record.messageId;
    if (
      record.role === 'assistant' &&
      record.usage !== null &&
      (messageId === null || !countedMessages.has(messageId))
    ) {
      if (messageId !== null) countedMessages.add(messageId);
      hasUsage = true;
      tokens.input += record.usage.input;
      tokens.output += record.usage.output;
      tokens.cacheRead += record.usage.cacheRead;
      tokens.cacheWrite += record.usage.cacheWrite;
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
    }
  });

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
    durationMs,
    records: stats.parsed,
    malformedLines: stats.malformed,
    models: models.toObject(),
    tools: tools.toObject(),
    roles: roles.toObject(),
    recordTypes: recordTypes.toObject(),
    primaryModel: models.top(new Set([SYNTHETIC_MODEL])),
    subsessionCount,
    tokens: hasUsage ? tokens : null,
    provider: 'claude',
  };
}
