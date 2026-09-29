import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { Provider } from './session-index.js';
import { overrideVariable } from './work/find-binary.js';
import { harnasHome } from './work/store.js';
import type { WorkProvider } from './work/types.js';

/**
 * В каком виде CLI принимает конфиг MCP-сервера — то есть чем становится
 * подстановка `{mcpConfig}`. `json-file` — путь к JSON (`claude --mcp-config`),
 * `codex-override` — `-c`-переопределение инлайн-таблицей TOML (у codex флага
 * под файл конфига нет, MCP-серверы живут в `~/.codex/config.toml`).
 * `undefined` — провайдер MCP не принимает, координация ему недоступна.
 */
export type McpConfigKind = 'json-file' | 'codex-override';

/**
 * Чем запись карты связывается с сессией в логах провайдера: id задан снаружи
 * (`claude --session-id`) или сопоставляется по cwd и времени запуска —
 * спецификация, раздел 5.
 */
export type SessionLink = 'session-id' | 'cwd+time';

export interface RunnerConfig {
  /**
   * Имя бинаря в PATH. Запускается только то, что уже стоит у пользователя,
   * и только немодифицированным — юридическая граница проекта.
   */
  command: string;
  /**
   * Аргументы запуска новой сессии координации. Подстановки: `{sessionUuid}` —
   * uuid, сгенерированный харнессом, `{mcpConfig}`, `{settingsFile}` — файл
   * настроек работы с хуками, `{systemPrompt}` — системная вставка гида,
   * `{channel}` — канал звонка, `{agent}` — роль, `{model}` и `{effort}` — выбор
   * из диалога окна (по `{model}` и `{effort}` в этом шаблоне окно узнаёт, что провайдер
   * их принимает: `supportsModel`, `supportsEffort`), `{prompt}` — стартовый бриф.
   * undefined — новая сессия запускается без аргументов.
   */
  args?: string[];
  /**
   * Аргументы для возобновления конкретной сессии. Подстановки:
   * `{providerSessionId}`, `{mcpConfig}`, `{settingsFile}`, `{systemPrompt}`,
   * `{channel}`, `{agent}`, `{prompt}` — указатель на письма при подъёме
   * спящей сессии (спецификация окна 7.2).
   * Системный промпт в транскрипте не хранится, поэтому вставка гида идёт и
   * сюда. undefined — провайдер не умеет открывать сессию по идентификатору,
   * запускаем без аргументов.
   */
  resumeArgs?: string[];
  /**
   * Аргументы режима одного ответа (`claude -p`): CLI получает промпт,
   * печатает ответ и выходит. Подстановка: `{prompt}`. Этим считается
   * дозаказ резюме (спецификация, раздел 6); undefined — провайдер так не умеет.
   */
  printArgs?: string[];
  mcpConfig?: McpConfigKind;
}

/** Запись реестра. Набор id открыт: `providers.json` добавляет свои CLI. */
export interface ProviderEntry {
  id: WorkProvider;
  /** Короткая подпись для бейджа провайдера в списке. */
  label: string;
  /** Двухсимвольный маркер для узкой колонки: первой буквы не хватает — Claude и Codex совпали бы. */
  mark: string;
  /** Умеем ли читать историю сессий этого провайдера. */
  hasHistory: boolean;
  linkBy: SessionLink;
  runner: RunnerConfig;
  /**
   * Закрытый список моделей, из которого окно предлагает выбрать (`selectableModels`).
   * Встроенные записи его не задают: документация Claude Code и Codex такого списка не
   * даёт — `--model` принимает и алиас, и полное имя. Список приходит только из
   * `providers.json`, то есть от самого человека.
   */
  models?: string[];
}

/** Запись встроенного реестра: id из закрытого списка, всё остальное как у `ProviderEntry`. */
export interface ProviderInfo extends Omit<ProviderEntry, 'id'> {
  id: Provider;
}

/**
 * Реестр провайдеров: где брать историю и чем запускать.
 *
 * GLM здесь runner-only: своей истории у него нет (проверено, см.
 * specs/runners.md), поэтому в списке сессий он не появляется, но запустить
 * его в правой панели можно тем же PTY-менеджером.
 */
export const PROVIDERS: Readonly<Record<Provider, ProviderInfo>> = {
  claude: {
    id: 'claude',
    label: 'Claude',
    mark: 'Cl',
    hasHistory: true,
    // `--session-id <uuid>` задаёт имя jsonl-файла заранее: угадывать по времени
    // создания не нужно.
    linkBy: 'session-id',
    runner: {
      command: 'claude',
      // `--settings` — документированный флаг Claude Code: файл мержится с
      // настройками пользователя, ничего в `~/.claude` не пишется (TUI v2, 4.2).
      args: [
        '--session-id',
        '{sessionUuid}',
        '--mcp-config',
        '{mcpConfig}',
        '--settings',
        '{settingsFile}',
        '--append-system-prompt',
        '{systemPrompt}',
        // Флаг документирован, но скрыт из `--help`: research preview канала
        // (спецификация 2026-09-08, 4.4). Пустая подстановка выбрасывает пару
        // целиком, как у `--mcp-config`, — тогда сессия живёт по pull.
        '--dangerously-load-development-channels',
        '{channel}',
        // Модель и усилие новой сессии из диалога окна. Оба флага документированы
        // (code.claude.com/docs/en/cli-reference: `--model`, `--effort`), а без выбора пара
        // выпадает целиком, и сессия живёт на модели и усилии по умолчанию. В `resumeArgs`
        // их нет: возобновлённая сессия остаётся на прежней модели (docs/en/sessions
        // того же сайта), а выбор в карте не хранится.
        '--model',
        '{model}',
        '--effort',
        '{effort}',
        '--agent',
        '{agent}',
        '{prompt}',
      ],
      resumeArgs: [
        '--resume',
        '{providerSessionId}',
        '--mcp-config',
        '{mcpConfig}',
        '--settings',
        '{settingsFile}',
        '--append-system-prompt',
        '{systemPrompt}',
        '--dangerously-load-development-channels',
        '{channel}',
        '--agent',
        '{agent}',
        // Указатель на письма, которыми хост поднимает спящую сессию (спека окна
        // 7.2): первым ходом возобновлённой сессии. Ручной подъём идёт без него —
        // пустая подстановка просто выпадает.
        '{prompt}',
      ],
      // `-p <промпт>` — один ответ без интерактива: им считается дозаказ резюме.
      printArgs: ['-p', '{prompt}'],
      mcpConfig: 'json-file',
    },
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    mark: 'Cx',
    hasHistory: true,
    // Проверено по CLI codex 0.80: `resume_session_id` помечен `#[clap(skip)]` и
    // ставится только подкомандой `codex resume <SESSION_ID>`; флага задать id
    // новой сессии снаружи нет. Значит, запись карты связывается с rollout-логом
    // по cwd и времени запуска (спецификация, раздел 5).
    linkBy: 'cwd+time',
    runner: {
      // `codex [OPTIONS] [PROMPT]`: стартовый промпт — позиционный аргумент.
      // MCP-серверы codex берёт из `~/.codex/config.toml`; свой сервер добавляем
      // глобальным `-c mcp_servers.harnas=<inline table>`, не трогая файл
      // пользователя. Файла-конфига MCP, как у claude, у codex нет.
      command: 'codex',
      // Модель — `--model` (`-m`), усилие — переопределением конфига: выделенного флага у
      // Codex нет, а ключ `model_reasoning_effort` есть в справочнике конфига. `-c key=value`
      // разбирает значение как TOML (справочник CLI Codex, флаг `--config`), поэтому строка
      // в кавычках; так же передаёт усилие SDK самого Codex (openai/codex,
      // sdk/typescript/src/exec.ts). Как и у claude, без выбора обе пары выпадают, а при
      // `resume` не передаются.
      args: [
        '-c',
        '{mcpConfig}',
        '--model',
        '{model}',
        '-c',
        'model_reasoning_effort="{effort}"',
        '{prompt}',
      ],
      // `codex resume <SESSION_ID>` — id или имя сессии, см. CLI самого Codex.
      resumeArgs: ['resume', '{providerSessionId}', '-c', '{mcpConfig}'],
      mcpConfig: 'codex-override',
    },
  },
  glm: {
    id: 'glm',
    label: 'GLM',
    mark: 'GL',
    hasHistory: false,
    linkBy: 'cwd+time',
    runner: { command: 'glm' },
  },
};

/** Провайдеры, чьи сессии попадают в список. */
export function providersWithHistory(): ProviderInfo[] {
  return Object.values(PROVIDERS).filter((provider) => provider.hasHistory);
}

/**
 * Усилие рассуждений, которое окно предлагает при запуске. Три уровня — общее подмножество
 * того, что документируют Claude Code (`low`…`max`) и Codex (`low`…`ultra`, набор зависит от
 * модели). Уровень, которого модель Claude не знает, Claude Code сам опускает до ближайшего
 * ниже (code.claude.com/docs/en/model-config); про Codex документация этого не говорит.
 */
export type EffortLevel = 'low' | 'medium' | 'high';

/** Значения подстановок в шаблоны аргументов реестра. */
export interface RunnerSubstitutions {
  sessionUuid?: string;
  mcpConfig?: string;
  /** Путь к `settings.json` работы с хуками (дизайн TUI v2, раздел 4.2). */
  settingsFile?: string;
  /** Системная вставка гида (`work/guidance.ts`): кто ты и чем пользоваться. */
  systemPrompt?: string;
  prompt?: string;
  providerSessionId?: string;
  /** Канал звонка: `server:harnas` при включённом push, иначе подстановки нет. */
  channel?: string;
  /** Имя роли для `claude --agent` (спецификация 2026-09-08, 4.4). */
  agent?: string;
  /** Модель новой сессии из диалога окна: `--model` у claude и codex. */
  model?: string;
  /**
   * Усилие новой сессии: `--effort` у claude, `-c model_reasoning_effort` у codex. Тип — закрытый
   * набор, потому что у codex значение встаёт в кавычки строки шаблона без экранирования.
   */
  effort?: EffortLevel;
}

const PLACEHOLDER =
  /^\{(sessionUuid|mcpConfig|settingsFile|systemPrompt|prompt|providerSessionId|channel|agent|model|effort)\}$/;

/**
 * Усилие можно подставить и внутрь строки шаблона (`model_reasoning_effort="{effort}"`):
 * Codex принимает его только значением TOML в `-c`. Остальным подстановкам это не нужно —
 * и не позволено: усилие берётся из закрытого набора, и его можно вставить в кавычки без
 * экранирования, а модель — произвольная строка.
 */
const INLINE_EFFORT = /\{effort\}/g;

/**
 * Подставляет значения в шаблон аргументов.
 *
 * Подстановка без значения выпадает вместе с флагом, который её вводит, —
 * предыдущим аргументом, если он пришёл из шаблона литералом и начинается с
 * `-`. Иначе от `--mcp-config {mcpConfig}` остался бы висячий флаг. Значение,
 * само похожее на флаг, соседа не уносит: оно литералом шаблона не было.
 */
export function substituteArgs(template: readonly string[], subs: RunnerSubstitutions): string[] {
  const args: string[] = [];
  const fromTemplate: boolean[] = [];

  /** Пропавшая подстановка уносит флаг, который стоял перед ней литералом шаблона. */
  const dropWithFlag = (): void => {
    const last = args.length - 1;
    if (last >= 0 && fromTemplate[last] === true && args[last]?.startsWith('-') === true) {
      args.pop();
      fromTemplate.pop();
    }
  };

  for (const item of template) {
    const match = PLACEHOLDER.exec(item);
    if (match === null) {
      if (!item.includes('{effort}')) {
        args.push(item);
        fromTemplate.push(true);
        continue;
      }
      // Значения нет — выпадает вся строка вместе с её `-c`; есть — оно встаёт на место.
      if (subs.effort === undefined) {
        dropWithFlag();
        continue;
      }
      const effort = subs.effort;
      args.push(item.replace(INLINE_EFFORT, () => effort));
      fromTemplate.push(false);
      continue;
    }

    const value = subs[match[1] as keyof RunnerSubstitutions];
    if (value === undefined) {
      dropWithFlag();
      continue;
    }
    args.push(value);
    fromTemplate.push(false);
  }
  return args;
}

/** Команда и аргументы запуска новой сессии провайдера. */
export function startCommand(
  entry: ProviderEntry,
  subs: RunnerSubstitutions = {},
): { command: string; args: string[] } {
  return { command: entry.runner.command, args: substituteArgs(entry.runner.args ?? [], subs) };
}

/** Команда и аргументы возобновления сессии провайдера. */
export function resumeCommand(
  entry: ProviderEntry,
  subs: RunnerSubstitutions = {},
): { command: string; args: string[] } {
  return {
    command: entry.runner.command,
    args: substituteArgs(entry.runner.resumeArgs ?? [], subs),
  };
}

/** Команда и аргументы режима одного ответа: промпт на вход, ответ в stdout. */
export function printCommand(
  entry: ProviderEntry,
  subs: RunnerSubstitutions = {},
): { command: string; args: string[] } {
  return {
    command: entry.runner.command,
    args: substituteArgs(entry.runner.printArgs ?? [], subs),
  };
}

/** Стоит ли подстановка в шаблоне запуска новой сессии — значит, провайдер принимает её флаг. */
const startTemplateHas = (entry: ProviderEntry, placeholder: string): boolean =>
  (entry.runner.args ?? []).some((item) => item.includes(placeholder));

/**
 * Принимает ли провайдер модель при запуске. Решает шаблон, а не отдельный признак реестра:
 * флаг подтверждён документацией CLI ровно там, где он стоит в `args`, а оверрайд
 * `providers.json` без `{model}` честно его выключает. Не принимает — выбор молча
 * отбрасывается (`substituteArgs`), а окно контрол прячет.
 */
export const supportsModel = (entry: ProviderEntry): boolean => startTemplateHas(entry, '{model}');

/** Принимает ли провайдер усилие при запуске — по тому же правилу, что и модель. */
export const supportsEffort = (entry: ProviderEntry): boolean => startTemplateHas(entry, '{effort}');

/**
 * Закрытый список моделей для окна: только из записи реестра (то есть из `providers.json`) и
 * только если шаблон запуска вообще принимает модель. `null` — списка нет: документация
 * Claude Code и Codex его не даёт, `--model` принимает и алиас, и полное имя.
 */
export function selectableModels(entry: ProviderEntry): string[] | null {
  if (!supportsModel(entry) || entry.models === undefined || entry.models.length === 0) return null;
  return [...entry.models];
}

/**
 * Что именно запускается вместо команды провайдера. Оверрайд нужен
 * нестандартным установкам и тестам, где вместо настоящего агента стоит stub;
 * никакой подмены бинаря за спиной пользователя здесь нет.
 */
export function commandBinary(command: string, env: NodeJS.ProcessEnv = process.env): string {
  return env[overrideVariable(command)] ?? command;
}

/**
 * Метки родительской сессии: Claude Code ставит их своим дочерним процессам, а
 * харнесс — никогда. Значит, значение в окружении — наследство: хост или CLI
 * запущен из сессии Claude Code. Агент с такой меткой считает себя вложенным в чужую
 * сессию, а интерактивный вдобавок перестаёт писать транскрипт (claude 2.1.283:
 * «Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker») —
 * тот самый, по которому харнесс строит индекс сессий, метрики и страховку
 * активности. Claude Code и сам поднимает свои фоновые сессии без этих меток.
 */
const PARENT_SESSION_ENV = [
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
];

/** Окружение запускаемого агента: всё то же, кроме меток родительской сессии. */
export function agentEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env };
  for (const name of PARENT_SESSION_ENV) delete clean[name];
  return clean;
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    const info = await stat(candidate);
    if (!info.isFile()) return false;
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Есть ли команда провайдера в PATH. `spawn_session` отказывает сразу, если
 * бинаря нет (спецификация, раздел 8), — записи в карте при этом не появляется.
 *
 * Учитывается та же переменная-оверрайд, что и при запуске в PTY
 * (`work/find-binary.ts`): иначе проверка отвергала бы
 * провайдера, которого харнесс на самом деле запустит.
 */
export async function commandInPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const binary = commandBinary(command, env);
  if (binary === '') return false;
  if (binary.includes(path.sep)) return isExecutableFile(path.resolve(binary));

  for (const dir of (env['PATH'] ?? '').split(path.delimiter)) {
    if (dir === '') continue;
    if (await isExecutableFile(path.join(dir, binary))) return true;
  }
  return false;
}

/** Необязательный файл переопределений и дополнений реестра. */
export function providersFile(): string {
  return path.join(harnasHome(), 'providers.json');
}

/** Запись `providers.json`: плоская, все поля необязательные (спецификация, раздел 5). */
export interface ProviderOverride {
  badge?: string;
  mark?: string;
  hasHistory?: boolean;
  linkBy?: SessionLink;
  command?: string;
  args?: string[];
  resumeArgs?: string[];
  printArgs?: string[];
  mcpConfig?: McpConfigKind;
  models?: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

function checkShape(id: string, file: string, patch: Record<string, unknown>): void {
  const wrong =
    (patch['badge'] !== undefined && typeof patch['badge'] !== 'string') ||
    (patch['mark'] !== undefined && typeof patch['mark'] !== 'string') ||
    (patch['hasHistory'] !== undefined && typeof patch['hasHistory'] !== 'boolean') ||
    (patch['linkBy'] !== undefined &&
      patch['linkBy'] !== 'session-id' &&
      patch['linkBy'] !== 'cwd+time') ||
    (patch['command'] !== undefined && typeof patch['command'] !== 'string') ||
    (patch['args'] !== undefined && !isStrings(patch['args'])) ||
    (patch['resumeArgs'] !== undefined && !isStrings(patch['resumeArgs'])) ||
    (patch['printArgs'] !== undefined && !isStrings(patch['printArgs'])) ||
    (patch['models'] !== undefined && !isStrings(patch['models'])) ||
    (patch['mcpConfig'] !== undefined &&
      patch['mcpConfig'] !== 'json-file' &&
      patch['mcpConfig'] !== 'codex-override');
  if (wrong) throw new Error(`провайдер ${id} в ${file}: неожиданная форма записи`);
}

/** Накладывает переопределение на запись встроенного реестра (или создаёт свою). */
function applyOverride(
  id: string,
  file: string,
  patch: ProviderOverride,
  base: ProviderEntry | undefined,
): ProviderEntry {
  const command = patch.command ?? base?.runner.command;
  const label = patch.badge ?? base?.label;
  if (command === undefined || command === '' || label === undefined || label === '') {
    throw new Error(`провайдер ${id} в ${file}: новому провайдеру нужны badge и command`);
  }

  const runner: RunnerConfig = { command };
  const args = patch.args ?? base?.runner.args;
  const resumeArgs = patch.resumeArgs ?? base?.runner.resumeArgs;
  const printArgs = patch.printArgs ?? base?.runner.printArgs;
  const mcpConfig = patch.mcpConfig ?? base?.runner.mcpConfig;
  if (args !== undefined) runner.args = args;
  if (resumeArgs !== undefined) runner.resumeArgs = resumeArgs;
  if (printArgs !== undefined) runner.printArgs = printArgs;
  if (mcpConfig !== undefined) runner.mcpConfig = mcpConfig;

  const models = patch.models ?? base?.models;
  return {
    id,
    label,
    mark: patch.mark ?? base?.mark ?? label.slice(0, 2),
    hasHistory: patch.hasHistory ?? base?.hasHistory ?? false,
    linkBy: patch.linkBy ?? base?.linkBy ?? 'cwd+time',
    runner,
    ...(models === undefined ? {} : { models }),
  };
}

/**
 * Встроенный реестр плюс необязательные переопределения из
 * `HARNAS_HOME/providers.json`: merge по id, свои провайдеры добавляются.
 * Битый файл — ошибка: реестр пишем не мы, но догадываться о его форме нельзя,
 * иначе харнесс молча запустит не то, что просил пользователь.
 */
export async function loadProviders(
  file = providersFile(),
): Promise<Record<WorkProvider, ProviderEntry>> {
  const registry: Record<WorkProvider, ProviderEntry> = Object.fromEntries(
    Object.values(PROVIDERS).map((entry) => [
      entry.id,
      { ...entry, runner: { ...entry.runner } } as ProviderEntry,
    ]),
  );

  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return registry;
    throw error;
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new Error(`реестр провайдеров ${file} не парсится: ${(error as Error).message}`);
  }
  if (!isRecord(data)) {
    throw new Error(`реестр провайдеров ${file} не парсится: неожиданная форма`);
  }

  for (const [id, patch] of Object.entries(data)) {
    if (!isRecord(patch)) throw new Error(`провайдер ${id} в ${file}: неожиданная форма записи`);
    checkShape(id, file, patch);
    registry[id] = applyOverride(id, file, patch as ProviderOverride, registry[id]);
  }
  return registry;
}
