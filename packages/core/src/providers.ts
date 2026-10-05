import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { CLAUDE_MODELS, CODEX_MODELS, GLM_MODELS, type ModelOption } from './provider-models.js';
import { readSecret, type SecretId } from './secrets.js';
import { parseVersion } from './work/channel.js';
import type { Provider } from './session-index.js';
import { overrideValue } from './work/find-binary.js';
import { parleyHome } from './work/store.js';
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

export type ProviderFamily = 'claude';

export interface RunnerConfig {
  /** Trusted built-in nonsensitive process environment; never settings.env or a key. */
  env?: Readonly<Record<string, string>>;
  /** Initial settings model; GLM resume keeps this or the persisted WorkSession.model. */
  settingsModel?: string;
  /** Host retrieves this secret only immediately before launch. */
  secret?: SecretId;
  /** Minimum verified CLI version; host checks it before launch side effects. */
  minVersion?: string;
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
   * их принимает: `supportsModel`, `supportsEffort`), `{prompt}` — стартовый бриф,
   * `{notify}` — `-c notify=[…]` Codex (скрипт харнесса, который после хода дописывает `Stop`
   * в журнал событий сессии).
   * undefined — новая сессия запускается без аргументов.
   */
  args?: string[];
  /**
   * Аргументы для возобновления конкретной сессии. Подстановки:
   * `{providerSessionId}`, `{mcpConfig}`, `{settingsFile}`, `{systemPrompt}`,
   * `{channel}`, `{agent}`, `{model}`, `{notify}`, `{prompt}` — указатель на письма при подъёме
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
  /** Trusted built-in transcript/CLI family; providers.json cannot define it. */
  family?: ProviderFamily;
  /** Короткая подпись для бейджа провайдера в списке. */
  label: string;
  /** Двухсимвольный маркер для узкой колонки: первой буквы не хватает — Claude и Codex совпали бы. */
  mark: string;
  /** Умеем ли читать историю сессий этого провайдера. */
  hasHistory: boolean;
  linkBy: SessionLink;
  runner: RunnerConfig;
  /**
   * Модели, из которых окно предлагает выбрать (`selectableModels`): значение `--model` и подпись.
   * У встроенных `claude`, `codex` и `glm` список взят из открытой документации (`provider-models.ts`), у
   * прочих — из `providers.json`. Нет списка (`null` или поля нет — одно и то же, как и на проводе) —
   * окно контрол не показывает, а хост принимает любое значение, как и прежде. «По умолчанию» в
   * списке не хранится: это отсутствие выбора, без флага.
   */
  models?: readonly ModelOption[] | null;
}

/** Запись встроенного реестра: id из закрытого списка, всё остальное как у `ProviderEntry`. */
export interface ProviderInfo extends Omit<ProviderEntry, 'id'> {
  id: Provider;
}

/**
 * Настройки Codex, которые харнесс задаёт флагами `-c` (спека комнат Organic, 3.6) — и при запуске, и при
 * `resume`. Только своими `-c` в своих сессиях: личный конфиг человека в домашней папке Codex не читается и
 * не пишется, его `notify` в этих сессиях не зовётся.
 * - `mcp_servers.parley` — сервер координации (`{mcpConfig}`);
 * - `tui.terminal_title` — состояние в заголовке окна (OSC 0): спиннер идёт, пока агент работает,
 *   `status` даёт `Ready` и `Working`, при вопросе человеку заголовок становится
 *   `[ ! ] Action Required`; `session-id` — id треда;
 * - `tui.notifications` (`approval-requested`, `agent-turn-complete`), способ `osc9` и условие
 *   `always` — те же события уведомлениями терминала; по умолчанию они молчат, пока терминал «в фокусе»,
 *   а для Codex в pty хоста фокус всегда «есть»;
 * - `notify` — конец хода скриптом харнесса (`{notify}`).
 * Хуки Codex не включаются (`hooks.*`): им нужно ревью человека, а доверие себе харнесс не выдаёт.
 * Так же не выдаётся доверие к папке (`projects`): экран доверия проходит человек в терминале Codex.
 */
const CODEX_CONFIG_FLAGS: readonly string[] = [
  '-c',
  '{mcpConfig}',
  '-c',
  'tui.terminal_title=["spinner","status","session-id"]',
  '-c',
  'tui.notifications=["approval-requested","agent-turn-complete"]',
  '-c',
  'tui.notification_method="osc9"',
  '-c',
  'tui.notification_condition="always"',
  '-c',
  '{notify}',
];

/**
 * Флаги запуска новой сессии Codex: `-c` (`CODEX_CONFIG_FLAGS`) и два флага сверх них.
 * - `--no-daemon` — Codex с 0.157 по умолчанию идёт через общий фоновый демон, и тогда MCP-серверы и
 *   уведомления были бы детьми демона с его окружением, без `PARLEY_*` и `HARNAS_*`. Любой `-c` и так держит
 *   запуск «встроенным», флаг делает это явным;
 * - `-a on-request` — вопросы одобрений идут человеку в терминал агента (это и умолчание Codex, но
 *   личный конфиг человека мог его сменить). Флаг заменяет в сессиях харнесса и личную политику
 *   одобрений человека, в том числе более строгую, если она задана в его конфиге. `never` нельзя: вызов
 *   инструмента, требующий одобрения, при нём отклоняется — сервер `parley` перестал бы работать.
 * При `resume` их нет: спека говорит «те же `-c`», принимает ли `resume` эти флаги после id, на живом Codex
 * не проверено (отказ разбора флагов провалил бы каждый подъём спящей сессии), а тред хранит политику
 * одобрений и без них.
 */
const CODEX_PARLEY_FLAGS: readonly string[] = ['--no-daemon', '-a', 'on-request', ...CODEX_CONFIG_FLAGS];

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
    family: 'claude',
    label: 'Claude',
    mark: 'Cl',
    hasHistory: true,
    // `--session-id <uuid>` задаёт имя jsonl-файла заранее: угадывать по времени
    // создания не нужно.
    linkBy: 'session-id',
    // Алиасы `--model` из документации Claude Code (`provider-models.ts`).
    models: CLAUDE_MODELS,
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
        // того же сайта), а выбор из диалога в карте не хранится.
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
    // Сверено по исходникам codex 0.159 (`codex-research.md`, п. 11.8): `resume_session_id`
    // помечен `#[clap(skip)]` и ставится только подкомандой `codex resume <SESSION_ID>`;
    // флага задать id новой сессии снаружи нет. Значит, запись карты связывается с
    // rollout-логом по cwd и времени запуска (спецификация, раздел 5).
    linkBy: 'cwd+time',
    // Рекомендуемые модели из документации Codex (`provider-models.ts`).
    models: CODEX_MODELS,
    runner: {
      // `codex [OPTIONS] [PROMPT]`: стартовый промпт — позиционный аргумент.
      // MCP-серверы codex берёт из `~/.codex/config.toml`; свой сервер добавляем
      // глобальным `-c mcp_servers.parley=<inline table>`, не трогая файл
      // пользователя. Файла-конфига MCP, как у claude, у codex нет.
      command: 'codex',
      // Свои настройки сессии — `CODEX_PARLEY_FLAGS`. Модель — `--model` (`-m`), усилие —
      // переопределением конфига: выделенного флага у Codex нет, а ключ `model_reasoning_effort`
      // есть в справочнике конфига. `-c key=value` разбирает значение как TOML (справочник CLI
      // Codex, флаг `--config`), поэтому строка в кавычках; так же передаёт усилие SDK самого Codex
      // (openai/codex, sdk/typescript/src/exec.ts). Как и у claude, без выбора обе пары выпадают, а
      // при `resume` не передаются.
      args: [
        ...CODEX_PARLEY_FLAGS,
        '--model',
        '{model}',
        '-c',
        'model_reasoning_effort="{effort}"',
        '{prompt}',
      ],
      // `codex resume <SESSION_ID> [PROMPT]` — id или имя сессии, см. CLI самого Codex. Те же `-c`, что у
      // запуска (`-c mcp_servers` в тред не сохраняется, `notify` и заголовок тоже), а `--no-daemon` и
      // `-a` — только у запуска. Модель, усилие и политику одобрений Codex восстанавливает из треда сам.
      // Указатель на письма — позиционным промптом последним: первым ходом поднятой сессии.
      resumeArgs: ['resume', '{providerSessionId}', ...CODEX_CONFIG_FLAGS, '{prompt}'],
      mcpConfig: 'codex-override',
    },
  },
  glm: {
    id: 'glm',
    label: 'GLM',
    mark: 'GL',
    family: 'claude',
    hasHistory: true,
    linkBy: 'session-id',
    models: GLM_MODELS,
    runner: {
      command: 'claude',
      secret: 'zai',
      minVersion: '2.1.287',
      settingsModel: 'glm-5.3[1m]',
      // These must reach the process: host-managed Claude filters provider env from settings.
      env: {
        CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
        ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3[1m]',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.3[1m]',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.3-flash[1m]',
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        API_TIMEOUT_MS: '3000000',
      },
      args: [
        '--session-id',
        '{sessionUuid}',
        '--mcp-config',
        '{mcpConfig}',
        '--settings',
        '{settingsFile}',
        '--append-system-prompt',
        '{systemPrompt}',
        '--model',
        '{model}',
        '--effort',
        '{effort}',
        '--agent',
        '{agent}',
        '{prompt}',
      ],
      // Tier aliases suppress native restoration. Explicitly keep the configured launch model.
      resumeArgs: [
        '--resume',
        '{providerSessionId}',
        '--mcp-config',
        '{mcpConfig}',
        '--settings',
        '{settingsFile}',
        '--append-system-prompt',
        '{systemPrompt}',
        '--model',
        '{model}',
        '--agent',
        '{agent}',
        '{prompt}',
      ],
      mcpConfig: 'json-file',
    },
  },
};

/** Built-in Claude Code family, independent of provider label, command or allowed overrides. */
export function isClaudeCode(entry: ProviderEntry | WorkProvider): boolean {
  return typeof entry === 'string'
    ? Object.values(PROVIDERS).some(
        (provider) => provider.id === entry && provider.family === 'claude',
      )
    : entry.family === 'claude';
}

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

/** Те же уровни списком: по нему проверяет `effort` `spawn_session`, а схема окна держит свой набор. */
export const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high'];

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
  /** Канал звонка: `server:parley` при включённом push, иначе подстановки нет. */
  channel?: string;
  /** Имя роли для `claude --agent` (спецификация 2026-09-08, 4.4). */
  agent?: string;
  /** Значение `-c notify=[…]` Codex: скрипт харнесса, который пишет конец хода в журнал событий. */
  notify?: string;
  /** Модель новой сессии из диалога окна: `--model` у claude и codex. */
  model?: string;
  /**
   * Усилие новой сессии: `--effort` у claude, `-c model_reasoning_effort` у codex. Тип — закрытый
   * набор, потому что у codex значение встаёт в кавычки строки шаблона без экранирования.
   */
  effort?: EffortLevel;
}

const PLACEHOLDER =
  /^\{(sessionUuid|mcpConfig|settingsFile|systemPrompt|prompt|providerSessionId|channel|agent|notify|model|effort)\}$/;

/**
 * Усилие можно подставить и внутрь строки шаблона (`model_reasoning_effort="{effort}"`):
 * Codex принимает его только значением TOML в `-c`. Остальным подстановкам это не нужно —
 * и не позволено: усилие берётся из закрытого набора, и его можно вставить в кавычки без
 * экранирования, а модель — произвольная строка.
 */
const INLINE_EFFORT = /\{effort\}/g;

/**
 * Подставляет значения в шаблон аргументов. Подстановка — целым элементом массива; внутри строки
 * шаблона умеет встать только `{effort}` (`model_reasoning_effort="{effort}"`), так что
 * `--model={model}` остаётся буквальной строкой (`supportsModel` такой шаблон не считает).
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

/**
 * Принимает ли провайдер модель при запуске. Решает шаблон, а не отдельный признак реестра:
 * флаг подтверждён документацией CLI ровно там, где он стоит в `args`, а оверрайд
 * `providers.json` без `{model}` честно его выключает. Не принимает — выбор молча
 * отбрасывается (`substituteArgs`), а окно контрол прячет.
 *
 * Считается только `{model}` целым элементом, как его и подставляет `substituteArgs`: внутри
 * строки (`--model={model}`) он не подставился бы, и окно показало бы контрол, а в команду ушёл
 * бы буквальный `--model={model}`.
 */
export const supportsModel = (entry: ProviderEntry): boolean =>
  (entry.runner.args ?? []).some((item) => item === '{model}');

/**
 * Принимает ли провайдер усилие при запуске — по тому же правилу, что и модель, но `{effort}`
 * подставляется и внутри строки шаблона (`model_reasoning_effort="{effort}"`), поэтому годится
 * любой элемент с ним.
 */
export const supportsEffort = (entry: ProviderEntry): boolean =>
  (entry.runner.args ?? []).some((item) => item.includes('{effort}'));

/**
 * Список моделей для окна: из записи реестра (встроенный или из `providers.json`) и только если
 * шаблон запуска вообще принимает модель. `null` — списка нет: окно контрол не показывает, а хост
 * принимает любое значение по прежнему правилу. Отдаётся копия: ответ уходит по проводу, и правка
 * получателем не должна доходить до реестра.
 */
export function selectableModels(entry: ProviderEntry): ModelOption[] | null {
  const list = entry.models;
  if (!supportsModel(entry) || list === undefined || list === null || list.length === 0) {
    return null;
  }
  return list.map((model) => ({ ...model }));
}

/**
 * Что именно запускается вместо команды провайдера. Оверрайд нужен
 * нестандартным установкам и тестам, где вместо настоящего агента стоит stub;
 * никакой подмены бинаря за спиной пользователя здесь нет.
 */
export function commandBinary(command: string, env: NodeJS.ProcessEnv = process.env): string {
  return overrideValue(command, env) ?? command;
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

/** Local, bounded version-only probe; no session/config/authentication operation. */
export function probeCliVersion(command: string, timeoutMs = 3000, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile(commandBinary(command, env), ['--version'], {
      env, timeout: timeoutMs, killSignal: 'SIGKILL', windowsHide: true,
    }, (error, stdout) => {
      const version = error === null ? parseVersion(stdout) : null;
      resolve(version === null ? null : version.join('.'));
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end();
  });
}

/** Custom commands cannot receive the built-in Z.ai authentication contract. */
export function providerCompatibilityError(entry: ProviderEntry): string | null {
  if (entry.runner.secret !== 'zai') return null;
  if (entry.runner.command !== 'claude') return 'GLM requires the official claude command; custom runner commands are unsupported';
  const flags = [...(entry.runner.args ?? []), ...(entry.runner.resumeArgs ?? [])];
  return flags.some((arg) => /^--(?:bare|safe-mode|setting-sources)(?:=|$)/.test(arg))
    ? 'GLM runner template is unsupported: --bare, --safe-mode and --setting-sources conflict with the shared host-managed configuration'
    : null;
}

export interface ProviderReadiness {
  needs: 'cli' | 'key' | null;
  /** Incompatible runner, distinct from an install/key action. */
  error: string | null;
  version: string | null;
}

export interface ProviderReadinessOptions {
  env?: NodeJS.ProcessEnv;
  /** Explicit null means an unknown version; absence requests a fresh probe. */
  version?: string | null;
  probeVersion?: (command: string) => Promise<string | null>;
  /** Optional snapshot when the caller has already read the key for its hint. */
  keyPresent?: boolean;
}

/** Shared preflight, before map/settings/worktree changes. Never returns a key. */
export async function providerReadiness(entry: ProviderEntry, options: ProviderReadinessOptions = {}): Promise<ProviderReadiness> {
  const error = providerCompatibilityError(entry);
  if (error !== null) return { needs: null, error, version: null };
  const env = options.env ?? process.env;
  if (!(await commandInPath(entry.runner.command, env))) return { needs: 'cli', error: null, version: null };
  let version: string | null = null;
  if (entry.runner.minVersion !== undefined) {
    version = options.version !== undefined
      ? options.version
      : await (options.probeVersion ?? ((command) => probeCliVersion(command, 3000, env)))(entry.runner.command);
    const have = version === null ? null : parseVersion(version);
    const need = parseVersion(entry.runner.minVersion);
    const supported = have !== null && need !== null && (
      have[0] > need[0] || (have[0] === need[0] && (have[1] > need[1] || (have[1] === need[1] && have[2] >= need[2])))
    );
    if (!supported) return { needs: 'cli', error: null, version };
  }
  if (entry.runner.secret !== undefined && !(options.keyPresent ?? ((await readSecret(entry.runner.secret)) !== null))) {
    return { needs: 'key', error: null, version };
  }
  return { needs: null, error: null, version };
}

/** Safe refusal text shared by MCP and host; includes no credentials. */
export function providerReadinessError(entry: ProviderEntry, readiness: ProviderReadiness): string | null {
  if (readiness.error !== null) return readiness.error;
  if (readiness.needs === 'cli') return entry.runner.minVersion === undefined
    ? `command ${entry.runner.command} is not in PATH — provider ${entry.id} is unavailable`
    : `GLM requires Claude Code ${entry.runner.minVersion} or newer; install or update the CLI and check again`;
  return readiness.needs === 'key' ? 'GLM requires a saved Z.ai key in Providers' : null;
}

/** Необязательный файл переопределений и дополнений реестра. */
export function providersFile(): string {
  return path.join(parleyHome(), 'providers.json');
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
  /**
   * Свой список моделей вместо встроенного, целиком (как `args`); `[]` убирает список. Элемент —
   * пара `{ id, label }`; `id` — одно слово, не с дефиса, до 200 знаков, и в списке не повторяется.
   */
  models?: ModelOption[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value !== '';

/**
 * Значение `--model`: одно слово, не с дефиса (CLI принял бы его за флаг) и не длиннее 200 знаков —
 * то же правило, что у `sessions.create.model` в protocol (тест хоста сверяет их между собой).
 * Слабее нельзя: список с таким значением загрузился бы, окно его показало бы, а `sessions.create`
 * с ним всегда падал бы на схеме.
 */
const MODEL_ID = /^[^\s-]\S*$/;
const MODEL_ID_MAX_LENGTH = 200;
const isModelId = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= MODEL_ID_MAX_LENGTH && MODEL_ID.test(value);

/**
 * Выбор модели против записи реестра: `null` — значение годится, иначе текст отказа. Одно правило на
 * два входа, `sessions.create` хоста и `spawn_session` MCP, чтобы они не разошлись: одно слово, не с
 * дефиса (CLI принял бы его за флаг), и — если у провайдера есть список (`selectableModels`) — из списка.
 * Пустое значение — «по умолчанию», без флага: его сюда не пускают, решает вызывающий. Провайдер без
 * списка принимает любое значение прежней формы: дойдёт ли оно до команды, решает шаблон запуска.
 */
export function modelChoiceError(entry: ProviderEntry, model: string): string | null {
  if (!isModelId(model)) {
    return `model ${JSON.stringify(model)}: must be one word, must not start with a hyphen and must not be longer than ${MODEL_ID_MAX_LENGTH} characters`;
  }
  const list = selectableModels(entry);
  if (list !== null && !list.some((option) => option.id === model)) {
    const allowed = list.map((option) => option.id).join(', ');
    return `model ${model} is not in the list of provider ${entry.id}; allowed: ${allowed}`;
  }
  return null;
}

const isModelEntry = (value: unknown): value is ModelOption =>
  isRecord(value) && isModelId(value['id']) && isNonEmptyString(value['label']);

/** Список пар без повторов `id`: два одинаковых окну не различить, а хост принял бы любое из них. */
const isModelList = (value: unknown): value is ModelOption[] =>
  Array.isArray(value) &&
  value.every(isModelEntry) &&
  new Set(value.map((model) => model.id)).size === value.length;

function checkShape(id: string, file: string, patch: Record<string, unknown>): void {
  const wrong =
    ['family', 'env', 'settingsModel', 'secret', 'minVersion', 'runner'].some(
      (name) => name in patch,
    ) ||
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
    (patch['models'] !== undefined && !isModelList(patch['models'])) ||
    (patch['mcpConfig'] !== undefined &&
      patch['mcpConfig'] !== 'json-file' &&
      patch['mcpConfig'] !== 'codex-override');
  if (wrong) throw new Error(`provider ${id} in ${file}: unexpected entry shape`);
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
    throw new Error(`provider ${id} in ${file}: a new provider needs badge and command`);
  }

  const runner: RunnerConfig = {
    ...base?.runner,
    command,
    ...(base?.runner.env === undefined ? {} : { env: { ...base.runner.env } }),
  };
  const args = patch.args ?? base?.runner.args;
  const resumeArgs = patch.resumeArgs ?? base?.runner.resumeArgs;
  const printArgs = patch.printArgs ?? base?.runner.printArgs;
  const mcpConfig = patch.mcpConfig ?? base?.runner.mcpConfig;
  if (args !== undefined) runner.args = args;
  if (resumeArgs !== undefined) runner.resumeArgs = resumeArgs;
  if (printArgs !== undefined) runner.printArgs = printArgs;
  if (mcpConfig !== undefined) runner.mcpConfig = mcpConfig;

  // Из файла в запись ложатся свои копии пар, а не объекты разобранного JSON.
  const models =
    patch.models === undefined
      ? base?.models
      : patch.models.map((model) => ({ id: model.id, label: model.label }));
  return {
    id,
    ...(base?.family === undefined ? {} : { family: base.family }),
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
 * `providers.json` дома (`parleyHome()`): merge по id, свои провайдеры добавляются.
 * Битый файл — ошибка: реестр пишем не мы, но догадываться о его форме нельзя,
 * иначе харнесс молча запустит не то, что просил пользователь.
 */
export async function loadProviders(
  file = providersFile(),
): Promise<Record<WorkProvider, ProviderEntry>> {
  const registry: Record<WorkProvider, ProviderEntry> = Object.fromEntries(
    Object.values(PROVIDERS).map((entry) => [
      entry.id,
      {
        ...entry,
        runner: {
          ...entry.runner,
          ...(entry.runner.env === undefined ? {} : { env: { ...entry.runner.env } }),
        },
      } as ProviderEntry,
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
    throw new Error(`provider registry ${file} cannot be parsed: ${(error as Error).message}`);
  }
  if (!isRecord(data)) {
    throw new Error(`provider registry ${file} cannot be parsed: unexpected shape`);
  }

  for (const [id, patch] of Object.entries(data)) {
    if (!isRecord(patch)) throw new Error(`provider ${id} in ${file}: unexpected entry shape`);
    checkShape(id, file, patch);
    registry[id] = applyOverride(id, file, patch as ProviderOverride, registry[id]);
  }
  return registry;
}
