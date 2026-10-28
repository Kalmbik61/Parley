import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { CLAUDE_MODELS, CODEX_MODELS, GLM_MODELS, LEGACY_EFFORTS, effortLabel, type EffortOption, type ModelOption } from './provider-models.js';
import { accountProviderEntry, customProviderEntry, customProvidersFile, isAccountRecord, isCustomProviderId, isManagedProviderId, readCustomProviders, type CustomAccountRecord, type CustomEndpointRecord, type CustomProviderRecord } from './custom-providers.js';
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
   * `{skillCatalog}` — `-c skills.include_instructions=false` Codex: убирает родной
   * каталог скиллов, только при включённом навигаторе и подтверждённом пути загрузки,
   * `{leanFlags}` — флаги облегчённого запуска (`work/lean.ts`), только у lean-сессии.
   * undefined — новая сессия запускается без аргументов.
   */
  args?: string[];
  /**
   * Аргументы для возобновления конкретной сессии. Подстановки:
   * `{providerSessionId}`, `{mcpConfig}`, `{settingsFile}`, `{systemPrompt}`,
   * `{channel}`, `{agent}`, `{model}`, `{effort}`, `{skillCatalog}`, `{leanFlags}`, `{prompt}` — указатель на письма
   * при подъёме спящей сессии (спецификация окна 7.2).
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
  /**
   * Ход помощника (спека 2026-10-14, 6.3): разовый запуск без терминала, инструменты — только MCP помощника.
   * Нет поля — провайдер помощнику не годится.
   */
  assistantArgs?: string[];
  /** То же со второго хода разговора: продолжение по `{providerSessionId}`. */
  assistantResumeArgs?: string[];
  mcpConfig?: McpConfigKind;
  /** Своя `CLAUDE_CONFIG_DIR` провайдера (спека своих провайдеров, 5.1); у встроенных нет. */
  configDir?: string;
  /** Как ключ уходит в процесс: `Authorization: Bearer` или `x-api-key` (спека, К11). */
  auth?: 'bearer' | 'api-key';
  /** Ключ не обязателен — адрес loopback (спека, 5.1). */
  keyOptional?: true;
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
   * Модели, из которых окно предлагает выбрать (`selectableModels`): значение `--model`, подпись и уровни
   * effort модели. У встроенных — из каталога `provider-models.ts` (у `codex` — из `codexModelsFile`, если он есть), у
   * прочих — из `providers.json`. Нет списка (`null` или поля нет — одно и то же, как и на проводе) —
   * окно контрол не показывает, а хост принимает любое значение, как и прежде. «По умолчанию» в
   * списке не хранится: это отсутствие выбора, без флага.
   */
  models?: readonly ModelOption[] | null;
  /**
   * `args` пришли из `providers.json`: принимает ли провайдер модель и effort, решает уже шаблон
   * человека (`supportsModel`, `supportsEffort`), и окно говорит об этом в карточке провайдера.
   * Поля нет — шаблон встроенный.
   */
  argsOverridden?: true;
  /** Описание своего провайдера с адресом, по которому построена запись (спека своих провайдеров, 5.3). */
  custom?: CustomEndpointRecord;
  /**
   * Запись аккаунта подписки, по которой построена запись (спека подписок 5.2). Отдельное поле навсегда: у аккаунта
   * нет адреса и ключа, а читатели `custom` берут `custom.baseUrl` и другие поля адреса. Условие «свой провайдер или
   * аккаунт» проверяют через `managedRecord` и `isManagedEntry`, а не вручную по двум полям.
   */
  account?: CustomAccountRecord;
}

/** Запись окна у провайдера, которым владеет окно (свой с адресом или аккаунт подписки): `custom ?? account`. */
export function managedRecord(entry: ProviderEntry): CustomProviderRecord | undefined {
  return entry.custom ?? entry.account;
}

/** Записью реестра владеет окно (свой провайдер или аккаунт), а не встроенный реестр и не `providers.json`. */
export function isManagedEntry(entry: ProviderEntry): boolean {
  return managedRecord(entry) !== undefined;
}

/**
 * У провайдера свой токен хуков `PARLEY_HOOK_CAPABILITY` и свой файл настроек `settings-<id>.json` (спека подписок 5.3,
 * К13): GLM, свой провайдер с адресом и аккаунт подписки. Общий `PARLEY_HOOK_TOKEN` остаётся у `claude` и `codex`.
 * Единственное место признака: `launch.ts` и хост берут его здесь, а не проверяют `custom` или `secret` поодиночке.
 */
export function ownsHookToken(entry: ProviderEntry): boolean {
  return entry.id === 'glm' || isManagedEntry(entry);
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
 * - `notify` человека не подменяется: конец хода Codex — OSC 9 и журнал (`task_complete`), спека 2026-10-07, 5.5;
 * - `skills.include_instructions` — родной каталог скиллов (`{skillCatalog}`): значение есть только при включённом
 *   навигаторе и подтверждённом пути загрузки, иначе пара выпадает и каталог остаётся полным.
 * - `{sandbox}` — `sandbox_mode` роли (`workspace-write` по умолчанию, `read-only` у ролей только для чтения);
 * - `{approvals}` — политика одобрений ключами `-c approval_policy=…` и `approvals_reviewer=…` (`work/codex-policy.ts`):
 *   по роли и настройке `codexWriteApprovals`, одни и те же пары при запуске и `resume`; флага `-a` в шаблоне нет
 *   (спека 2026-10-21, решения 9–11);
 * - `{trust}` — пара `-c projects={"<папка>"={trust_level="trusted"}}` (`trustArgs`): доверие к папке по согласию
 *   человека, которое хранит сам Parley (`trust.json`) и передаёт флагом; в `~/.codex` ничего не пишется. Нет
 *   согласия — подстановка выпадает (запуск до этого не доходит, спека 2026-10-21, 4.2–4.3).
 * Хуки Codex (`{codexHooks}`, `hooks.*`) включаются только в режиме `parley` настройки `codexWriteApprovals`
 * (спека 2026-10-21, решение 19): хуки не получают доверия, их одобряет человек в `/hooks`.
 * `{leanFlags}` — пары `-c mcp_servers.<id>.enabled=false` чужих серверов; есть только у lean-сессии (`work/lean.ts`).
 */
const CODEX_CONFIG_FLAGS: readonly string[] = [
  '-c',
  '{mcpConfig}',
  '-c',
  '{developerInstructions}',
  '-c',
  '{sandbox}',
  '{approvals}',
  '{trust}',
  '-c',
  'project_doc_fallback_filenames=["CLAUDE.md"]',
  '-c',
  'tui.terminal_title=["spinner","status","session-id"]',
  '-c',
  'tui.notifications=["approval-requested","agent-turn-complete"]',
  '-c',
  'tui.notification_method="osc9"',
  '-c',
  'tui.notification_condition="always"',
  '-c',
  '{skillCatalog}',
  '{codexHooks}',
  '{leanFlags}',
];

/**
 * Флаги запуска новой сессии Codex: `-c` (`CODEX_CONFIG_FLAGS`) и один флаг сверх них.
 * - `--no-daemon` — Codex с 0.157 по умолчанию идёт через общий фоновый демон, и тогда MCP-серверы и
 *   уведомления были бы детьми демона с его окружением, без `PARLEY_*` и `HARNAS_*`. Любой `-c` и так держит
 *   запуск «встроенным», флаг делает это явным.
 * Флага `-a on-request` больше нет: политика одобрений приходит ключами `-c` через `{approvals}` и по роли
 * (у ролей только для чтения это `never`, и сервер `parley` при нём работает — его инструменты одобрены конфигом
 * сервера), а `-c` одинаково принимают и запуск, и `resume`. При `resume` `--no-daemon` по-прежнему нет: принимает ли
 * `resume` этот флаг после id, на живом Codex не проверено (отказ разбора флагов провалил бы каждый подъём
 * спящей сессии).
 */
const CODEX_PARLEY_FLAGS: readonly string[] = ['--no-daemon', ...CODEX_CONFIG_FLAGS];

/**
 * Ход помощника (спека 2026-10-14, приложение A.2): только MCP помощника, без встроенных инструментов, без
 * настроек, хуков, плагинов и автопамяти человека. Промпт — сразу за `-p`: `--allowedTools`, `--tools` и
 * `--mcp-config` вариадические и «съели» бы его в конце.
 */
const CLAUDE_ASSISTANT_ARGS = [
  '-p', '{prompt}', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
  '--model', '{model}', '--mcp-config', '{mcpConfig}', '--strict-mcp-config', '--system-prompt', '{systemPrompt}',
  '--allowedTools', 'mcp__parley-assistant__*', '--tools', '', '--setting-sources', '', '--disable-slash-commands',
  '--settings', '{"autoMemoryEnabled":false}',
];
const CLAUDE_ASSISTANT_RESUME_ARGS = [...CLAUDE_ASSISTANT_ARGS, '--resume', '{providerSessionId}'];
/** Codex 0.162.0: хуки и `notify` человека, shell и прочие встроенные возможности выключены (приложение A.2). */
const CODEX_ASSISTANT_DISABLE = [
  'hooks', 'shell_tool', 'unified_exec', 'apps', 'plugins', 'browser_use', 'browser_use_external', 'computer_use',
  'goals', 'image_generation', 'view_image', 'multi_agent', 'skill_search', 'tool_suggest', 'sleep_tool',
].flatMap((feature) => ['--disable', feature]);
const CODEX_ASSISTANT_CONFIG = [
  '-c', 'web_search="disabled"', '-c', 'skills.include_instructions=false', '-c', 'include_apps_instructions=false',
  '-c', 'include_collaboration_mode_instructions=false', '-c', 'model_reasoning_effort="low"',
  '-c', '{mcpConfig}', '-c', '{developerInstructions}',
];
const CODEX_ASSISTANT_ARGS = [
  'exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '--ignore-user-config', '--ignore-rules',
  ...CODEX_ASSISTANT_DISABLE, ...CODEX_ASSISTANT_CONFIG, '--model', '{model}', '{prompt}',
];
/** У `exec resume` нет `--sandbox` — песочница ключом конфига. */
const CODEX_ASSISTANT_RESUME_ARGS = [
  'exec', 'resume', '--json', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules',
  ...CODEX_ASSISTANT_DISABLE, ...CODEX_ASSISTANT_CONFIG, '-c', 'sandbox_mode="read-only"',
  '--model', '{model}', '{providerSessionId}', '{prompt}',
];

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
        '{leanFlags}',
        '--append-system-prompt',
        '{systemPrompt}',
        // Флаг документирован, но скрыт из `--help`: research preview канала
        // (спецификация 2026-09-08, 4.4). Пустая подстановка выбрасывает пару
        // целиком, как у `--mcp-config`, — тогда сессия живёт по pull.
        '--dangerously-load-development-channels',
        '{channel}',
        // Модель и усилие из диалога окна или из карты сессии. Оба флага документированы
        // (code.claude.com/docs/en/cli-reference: `--model`, `--effort`), а без выбора пара
        // выпадает целиком, и сессия живёт на модели и усилии по умолчанию. Те же пары стоят и в
        // `resumeArgs`: effort возобновлённой сессии Claude Code сам не восстанавливает и без флага
        // уходит на умолчание (спека нормалайзера модели и effort, раздел 3, п. 6).
        // В карте хранится только явный выбор, без вычисленных defaults роли.
        '--model',
        '{model}',
        '--effort',
        '{effort}',
        '--agent',
        '{agent}',
        '--disallowedTools',
        '{disallowedTools}',
        // `--disallowedTools` вариадический: без `--` промпт стал бы ещё одним правилом запрета.
        // `--` ставится только при непустых `{disallowedTools}` и `{prompt}`.
        '--',
        '{prompt}',
      ],
      resumeArgs: [
        '--resume',
        '{providerSessionId}',
        '--mcp-config',
        '{mcpConfig}',
        '--settings',
        '{settingsFile}',
        '{leanFlags}',
        '--append-system-prompt',
        '{systemPrompt}',
        '--dangerously-load-development-channels',
        '{channel}',
        // Выбор из карты сессии (спека нормалайзера, 5.4). Нет выбора — пары выпадают, и модель
        // Claude Code при `--resume` восстанавливает сам.
        '--model',
        '{model}',
        '--effort',
        '{effort}',
        '--agent',
        '{agent}',
        '--disallowedTools',
        '{disallowedTools}',
        // Указатель на письма, которыми хост поднимает спящую сессию (спека окна
        // 7.2): первым ходом возобновлённой сессии. Ручной подъём идёт без него —
        // пустая подстановка просто выпадает. `--` не даёт вариадическому
        // `--disallowedTools` съесть промпт и ставится только при обоих значениях.
        '--',
        '{prompt}',
      ],
      // `-p <промпт>` — один ответ без интерактива: им считается дозаказ резюме.
      printArgs: ['-p', '{prompt}'],
      mcpConfig: 'json-file',
      assistantArgs: CLAUDE_ASSISTANT_ARGS,
      assistantResumeArgs: CLAUDE_ASSISTANT_RESUME_ARGS,
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
      // (openai/codex, sdk/typescript/src/exec.ts). Как и у claude, без выбора обе пары выпадают; при
      // `resume` их нет, в отличие от claude: тред Codex помнит модель и усилие сам.
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
      assistantArgs: CODEX_ASSISTANT_ARGS,
      assistantResumeArgs: CODEX_ASSISTANT_RESUME_ARGS,
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
        // Z.ai не даёт серверных проверок режима auto: без флага Claude Code держит первое действие на уведомлении о шлюзе.
        CLAUDE_CODE_AUTO_MODE_SERVER: '0',
        API_TIMEOUT_MS: '3000000',
      },
      args: [
        '--session-id',
        '{sessionUuid}',
        '--mcp-config',
        '{mcpConfig}',
        '--settings',
        '{settingsFile}',
        '{leanFlags}',
        '--append-system-prompt',
        '{systemPrompt}',
        '--model',
        '{model}',
        '--effort',
        '{effort}',
        '--agent',
        '{agent}',
        // «Только чтение» роли — как у claude: GLM — тот же Claude Code, флаг ему знаком.
        '--disallowedTools',
        '{disallowedTools}',
        // `--disallowedTools` вариадический: без `--` промпт стал бы ещё одним правилом запрета.
        // `--` ставится только при непустых `{disallowedTools}` и `{prompt}`.
        '--',
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
        '{leanFlags}',
        '--append-system-prompt',
        '{systemPrompt}',
        '--model',
        '{model}',
        // Effort из карты: без флага возобновлённая сессия ушла бы на умолчание Claude Code.
        '--effort',
        '{effort}',
        '--agent',
        '{agent}',
        // «Только чтение» роли — как у claude: GLM — тот же Claude Code, флаг ему знаком.
        '--disallowedTools',
        '{disallowedTools}',
        // `--disallowedTools` вариадический: без `--` промпт стал бы ещё одним правилом запрета.
        // `--` ставится только при непустых `{disallowedTools}` и `{prompt}`.
        '--',
        '{prompt}',
      ],
      mcpConfig: 'json-file',
      assistantArgs: CLAUDE_ASSISTANT_ARGS,
      assistantResumeArgs: CLAUDE_ASSISTANT_RESUME_ARGS,
    },
  },
};

/** Built-in Claude Code family, independent of provider label, command or allowed overrides. */
export function isClaudeCode(entry: ProviderEntry | WorkProvider): boolean {
  return typeof entry === 'string'
    ? Object.values(PROVIDERS).some(
        (provider) => provider.id === entry && provider.family === 'claude',
      ) || isCustomProviderId(entry)
    : entry.family === 'claude';
}

/**
 * `CLAUDE_CONFIG_DIR`, под которым живёт процесс провайдера семейства Claude Code. У GLM хост срезает
 * переменную (`provider-env.ts`): его конфигурация — `~/.claude`, и значение из окружения хоста или ведущего
 * агента ему не принадлежит. Одно правило для запуска, каталога ролей и поиска скиллов.
 */
export function claudeConfigDirFor(entry: ProviderEntry, env: NodeJS.ProcessEnv): string | undefined {
  return entry.runner.configDir ?? (entry.runner.secret === 'zai' ? undefined : env.CLAUDE_CONFIG_DIR);
}

/** Провайдеры, чьи сессии попадают в список. */
export function providersWithHistory(): ProviderInfo[] {
  return Object.values(PROVIDERS).filter((provider) => provider.hasHistory);
}

/**
 * Токен уровня effort: безопасен и в argv, и в кавычках TOML (`-c model_reasoning_effort="…"`) — ни
 * пробела, ни кавычки, ни обратной косой черты. Тем же правилом проверяют `substituteArgs` (до любой
 * подстановки), `resolveModelEffort`, уровни из `providers.json` и `parseMap`.
 */
export const EFFORT_TOKEN = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * Уровень effort — id из каталога модели (`ModelOption.efforts`): у Claude Code `low…max`, у моделей
 * Codex свои наборы, вплоть до `ultra`. Набор открыт, поэтому тип — строка; годится только значение,
 * проходящее `EFFORT_TOKEN`.
 */
export type EffortLevel = string;

/** Значения подстановок в шаблоны аргументов реестра. */
export interface RunnerSubstitutions {
  sessionUuid?: string;
  mcpConfig?: string;
  /** Путь к `settings.json` работы с хуками (дизайн TUI v2, раздел 4.2). */
  settingsFile?: string;
  /** Системная вставка гида (`work/guidance.ts`): кто ты и чем пользоваться. */
  systemPrompt?: string;
  /** Whole TOML assignment: developer_instructions=<JSON serialized layer>. */
  developerInstructions?: string;
  prompt?: string;
  providerSessionId?: string;
  /** Канал звонка: `server:parley` при включённом push, иначе подстановки нет. */
  channel?: string;
  /** Имя роли для `claude --agent` (спецификация 2026-09-08, 4.4). */
  agent?: string;
  /** Целое присваивание TOML `skills.include_instructions=false`: Codex без родного каталога скиллов. */
  skillCatalog?: string;
  /** Готовые пары `-c hooks.<Event>=…` (`work/codex-hooks.ts`): подставляются на место элемента, без значения — выпадают. */
  codexHooks?: readonly string[];
  /** Готовые пары `-c approval_policy=…`, `approvals_reviewer=…` (`work/codex-policy.ts`): разворачиваются на месте элемента, без значения — выпадают. */
  approvals?: readonly string[];
  /** Готовая пара `-c projects={…}` с доверием к папке (`trustArgs`): разворачивается на месте элемента, без значения — выпадает. */
  trust?: readonly string[];
  /** Готовые флаги облегчённого запуска (`work/lean.ts`): `--strict-mcp-config` у Claude, пары `-c …enabled=false` у Codex; без значения — выпадают. */
  leanFlags?: readonly string[];
  /** Модель новой сессии из диалога окна: `--model` у claude и codex. */
  model?: string;
  /**
   * Усилие: `--effort` у claude, `-c model_reasoning_effort` у codex. У codex значение встаёт в
   * кавычки строки шаблона без экранирования, поэтому `substituteArgs` пускает только `EFFORT_TOKEN`.
   */
  effort?: EffortLevel;
  disallowedTools?: string;
  sandbox?: string;
}

// `notify` остался в списке ради старых записей providers.json: значения нет, и пара `-c {notify}` выпадает.
const PLACEHOLDER =
  /^\{(sessionUuid|mcpConfig|settingsFile|systemPrompt|developerInstructions|prompt|providerSessionId|channel|agent|notify|skillCatalog|codexHooks|approvals|trust|model|effort|disallowedTools|sandbox|leanFlags)\}$/;

/**
 * Усилие можно подставить и внутрь строки шаблона (`model_reasoning_effort="{effort}"`):
 * Codex принимает его только значением TOML в `-c`. Остальным подстановкам это не нужно —
 * и не позволено: усилие проходит `EFFORT_TOKEN`, и его можно вставить в кавычки без
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
 *
 * Усилие, не прошедшее `EFFORT_TOKEN`, — исключение до любой подстановки: кавычка или пробел
 * разорвали бы TOML строки `model_reasoning_effort="{effort}"` или ушли бы в CLI лишним словом.
 */
export function substituteArgs(template: readonly string[], subs: RunnerSubstitutions): string[] {
  if (subs.effort !== undefined && !EFFORT_TOKEN.test(subs.effort)) {
    throw new Error(`effort ${JSON.stringify(subs.effort)} is not an effort level`);
  }
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
    // `--` перед `{prompt}` нужен, только если ему есть что закрывать (вариадический `--disallowedTools`)
    // и промпт задан; иначе он выпал бы в голый хвост запуска.
    if (item === '--') {
      if (subs.disallowedTools !== undefined && subs.prompt !== undefined) {
        args.push(item);
        fromTemplate.push(true);
      }
      continue;
    }
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
    if (Array.isArray(value)) {
      // Элемент-массив разворачивается на месте; флага-предшественника у него нет — пары `-c` в нём уже готовы.
      for (const part of value as readonly string[]) {
        args.push(part);
        fromTemplate.push(false);
      }
      continue;
    }
    if (value === undefined) {
      // У `{codexHooks}`, `{approvals}`, `{trust}` и `{leanFlags}` своего флага перед элементом нет — соседний флаг чужой.
      if (!['codexHooks', 'approvals', 'trust', 'leanFlags'].includes(match[1]!)) dropWithFlag();
      continue;
    }
    args.push(value as string);
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

/** Команда хода помощника (спека 2026-10-14, 6.3); `null` — у провайдера нет шаблона, помощнику он не годится. */
export function assistantCommand(
  entry: ProviderEntry,
  subs: RunnerSubstitutions,
  resume: boolean,
): { command: string; args: string[] } | null {
  const template = resume ? entry.runner.assistantResumeArgs : entry.runner.assistantArgs;
  return template === undefined ? null : { command: entry.runner.command, args: substituteArgs(template, subs) };
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
 * получателем не должна доходить до реестра — в том числе правка уровней: массив уровней у моделей
 * каталога общий.
 */
export function selectableModels(entry: ProviderEntry): ModelOption[] | null {
  const list = entry.models;
  if (!supportsModel(entry) || list === undefined || list === null || list.length === 0) {
    return null;
  }
  return list.map((model) =>
    model.efforts === undefined || model.efforts === null
      ? { ...model }
      : { ...model, efforts: model.efforts.map((effort) => ({ ...effort })) },
  );
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
  if (entry.runner.secret === undefined) return null;
  const name = entry.custom?.label ?? 'GLM';
  if (entry.runner.command !== 'claude') return `${name} requires the official claude command; custom runner commands are unsupported`;
  const flags = [...(entry.runner.args ?? []), ...(entry.runner.resumeArgs ?? [])];
  return flags.some((arg) => /^--(?:bare|safe-mode|setting-sources)(?:=|$)/.test(arg))
    ? `${name} runner template is unsupported: --bare, --safe-mode and --setting-sources conflict with the shared host-managed configuration`
    : null;
}

export interface ProviderReadiness {
  /** `sign-in` — у аккаунта подписки нет входа (спека подписок 5.5); CLI и версия при этом в порядке. */
  needs: 'cli' | 'key' | 'sign-in' | null;
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
  /**
   * Вошёл ли аккаунт подписки (его даёт служба входа хоста, спека подписок 5.5): `null` — не проверялось,
   * для аккаунта это тоже «нужен вход». Остальные провайдеры поле не читают.
   */
  signedIn?: boolean | null;
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
  // Вход — после CLI и версии: без подходящего `claude` проверять его не у кого (спека подписок 5.5).
  if (entry.account !== undefined && options.signedIn !== true) return { needs: 'sign-in', error: null, version };
  if (entry.runner.secret !== undefined && entry.runner.keyOptional !== true && !(options.keyPresent ?? ((await readSecret(entry.runner.secret)) !== null))) {
    return { needs: 'key', error: null, version };
  }
  return { needs: null, error: null, version };
}

/** Safe refusal text shared by MCP and host; includes no credentials. */
export function providerReadinessError(entry: ProviderEntry, readiness: ProviderReadiness): string | null {
  if (readiness.error !== null) return readiness.error;
  // Провайдер окна называется своим именем (`entry.label`: у аккаунта с пустой меткой стандартное уже посчитано).
  const name = isManagedEntry(entry) ? entry.label : 'GLM';
  if (readiness.needs === 'sign-in') return `${name} is not signed in: open Settings → Providers and press Sign in`;
  if (readiness.needs === 'cli') return entry.runner.minVersion === undefined
    ? `command ${entry.runner.command} is not in PATH — provider ${entry.id} is unavailable`
    : `${name} requires Claude Code ${entry.runner.minVersion} or newer; install or update the CLI and check again`;
  if (readiness.needs !== 'key') return null;
  return entry.custom === undefined
    ? 'GLM requires a saved Z.ai key in Providers'
    : `${entry.custom.label} requires a saved key in Settings → Providers`;
}

/** Необязательный файл переопределений и дополнений реестра. */
export function providersFile(): string {
  return path.join(parleyHome(), 'providers.json');
}

/**
 * Каталог моделей Codex, снятый хостом с `codex debug models` (спека нормалайзера, 5.2): файл Parley в доме,
 * `{ "fetchedAt": "<ISO>", "models": ModelOption[] }`. Пишет его только хост, атомарно, после удачной пробы.
 * `loadProviders` подставляет его модели в запись `codex`, поэтому окно, хост и MCP агента (отдельный
 * процесс) видят один список.
 */
export function codexModelsFile(): string {
  return path.join(parleyHome(), 'codex-models.json');
}

/**
 * Пределы подписи модели и описания уровня из каталога CLI: длиннее обрезают и разбор `codex debug models` в хосте,
 * и чтение `codexModelsFile` — внешний ввод не растягивает ни окно, ни ответ `get_map`.
 */
export const MODEL_LABEL_MAX = 100;
export const EFFORT_DESCRIPTION_MAX = 300;

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
  assistantArgs?: string[];
  assistantResumeArgs?: string[];
  mcpConfig?: McpConfigKind;
  /**
   * Свой список моделей вместо встроенного, целиком (как `args`); `[]` убирает список. Элемент —
   * `{ id, label }` и необязательные `efforts`; `id` — одно слово, не с дефиса, до 200 знаков, и в
   * списке не повторяется. `efforts` — уровни модели (непустой список токенов `EFFORT_TOKEN` без
   * повторов, подписи выводит `effortLabel`) или `null`, если effort у модели нет; без поля —
   * прежние `low|medium|high` (`effortsFor`).
   */
  models?: Array<{ id: string; label: string; efforts?: string[] | null }>;
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

/**
 * Уровни effort, из которых можно выбрать при этой модели: `model` — id из списка провайдера,
 * `undefined` — «Default» (без флага модели). `null` — effort выбрать нельзя: провайдер его не
 * принимает (нет `{effort}` в шаблоне) или у модели его нет (Haiku, пустой список). Правила (спека
 * нормалайзера, 5.1 и 5.3; окно повторяет их в `effortChoices`):
 * - провайдер без списка моделей, модель вне списка и модель без поля `efforts` (свой список из
 *   `providers.json` без уровней) — прежние `low|medium|high` (`LEGACY_EFFORTS`);
 * - «Default» — уровни, общие для всех моделей провайдера с уровнями, в порядке первой из них: какую
 *   модель возьмёт CLI, Parley не знает (настройки CLI рамка читать не даёт), а общий уровень годится
 *   любой. Общих нет — `null`.
 * Отдаётся копия, как у `selectableModels`.
 */
export function effortsFor(entry: ProviderEntry, model: string | undefined): EffortOption[] | null {
  if (!supportsEffort(entry)) return null;
  const legacy = (): EffortOption[] => LEGACY_EFFORTS.map((level) => ({ ...level }));
  const list = selectableModels(entry);
  if (list === null) return legacy();
  if (model !== undefined) {
    const option = list.find((candidate) => candidate.id === model);
    if (option === undefined || option.efforts === undefined) return legacy();
    return option.efforts === null || option.efforts.length === 0 ? null : option.efforts;
  }
  const lists = list.flatMap((option) => {
    const levels = option.efforts === undefined ? legacy() : option.efforts;
    return levels === null || levels.length === 0 ? [] : [levels];
  });
  const [first, ...rest] = lists;
  if (first === undefined) return null;
  const shared = first.filter((level) =>
    rest.every((levels) => levels.some((other) => other.id === level.id)),
  );
  return shared.length === 0 ? null : shared;
}

/** Выбор модели и effort; поля нет — «Default», без флага. */
export interface ModelEffortChoice {
  model?: string;
  effort?: string;
}

/** Итог `resolveModelEffort`: что ляжет в карту и в команду, или причина отказа. */
export type ModelEffortResolution = { choice: ModelEffortChoice } | { error: string };

/**
 * Проверка пары «модель + effort» — одна для окна (`sessions.create` хоста) и MCP (`spawn_session`),
 * до записи в карту (спека нормалайзера, 5.3). Пустая строка и отсутствие поля — «Default»: в ответе
 * поля нет. Модель проверяет `modelChoiceError`. Effort должен проходить `EFFORT_TOKEN` и быть
 * уровнем из `effortsFor` для выбранной модели (или для «Default»). Флаг, которого нет в шаблоне
 * запуска, выбор отбрасывает молча, как и прежде: в ответ и в карту ложится только то, что дойдёт
 * до CLI. Ошибка — текст причины со списком допустимого.
 */
export function resolveModelEffort(
  entry: ProviderEntry,
  choice: ModelEffortChoice,
): ModelEffortResolution {
  const model = choice.model === '' ? undefined : choice.model;
  const effort = choice.effort === '' ? undefined : choice.effort;
  if (model !== undefined) {
    const refusal = modelChoiceError(entry, model);
    if (refusal !== null) return { error: refusal };
  }
  const kept = model !== undefined && supportsModel(entry) ? model : undefined;
  const resolved: ModelEffortChoice = kept === undefined ? {} : { model: kept };
  if (effort === undefined) return { choice: resolved };

  const levels = effortsFor(entry, kept);
  const allowed = levels === null ? '' : `; allowed: ${levels.map((level) => level.id).join(', ')}`;
  if (!EFFORT_TOKEN.test(effort)) {
    return { error: `effort ${JSON.stringify(effort)} is not a level name${allowed}` };
  }
  if (!supportsEffort(entry)) return { choice: resolved };
  const subject = kept ?? 'the default model';
  if (levels === null) return { error: `${subject} has no effort levels; omit effort` };
  if (!levels.some((level) => level.id === effort)) {
    return { error: `${effort} is not a level of ${subject}${allowed}` };
  }
  return { choice: { ...resolved, effort } };
}

const isModelEntry = (value: unknown): value is ModelOption =>
  isRecord(value) && isModelId(value['id']) && isNonEmptyString(value['label']);

/** Список пар без повторов `id`: два одинаковых окну не различить, а хост принял бы любое из них. */
const isModelList = (value: unknown): value is ModelOption[] =>
  Array.isArray(value) &&
  value.every(isModelEntry) &&
  new Set(value.map((model) => model.id)).size === value.length;

/**
 * Уровни модели в `providers.json`: `null` — effort у модели нет, иначе непустой список токенов
 * `EFFORT_TOKEN` без повторов. Пустой список не «уровней нет» — для этого есть `null`.
 */
const isEffortList = (value: unknown): value is string[] | null =>
  value === null ||
  (Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === 'string' && EFFORT_TOKEN.test(item)) &&
    new Set(value).size === value.length);

/** Уровень из каталога Codex: id — токен, подпись непустая, описание — строка или его нет. */
const isEffortOption = (value: unknown): value is EffortOption =>
  isRecord(value) &&
  typeof value['id'] === 'string' &&
  EFFORT_TOKEN.test(value['id']) &&
  isNonEmptyString(value['label']) &&
  (value['description'] === undefined || typeof value['description'] === 'string');

/**
 * Модели из файла каталога Codex (`codexModelsFile`). Файла нет, он не разбирается, список пуст или хоть одна
 * модель или уровень не той формы — `null`: это кэш Parley, а не настройка человека, и тогда молча действует
 * запасной список. В запись ложатся только известные поля; подпись модели и описание уровня — не длиннее
 * `MODEL_LABEL_MAX` и `EFFORT_DESCRIPTION_MAX`, подпись уровня — `effortLabel(id)`, а не из файла.
 */
async function readCodexModels(file: string): Promise<ModelOption[] | null> {
  let data: unknown;
  try {
    data = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
  const models = isRecord(data) ? data['models'] : undefined;
  if (!isModelList(models) || models.length === 0) return null;
  const levelsValid = models.every(
    (model) =>
      model.efforts === undefined ||
      model.efforts === null ||
      (Array.isArray(model.efforts) &&
        model.efforts.length > 0 &&
        model.efforts.every(isEffortOption) &&
        new Set(model.efforts.map((level) => level.id)).size === model.efforts.length),
  );
  if (!levelsValid) return null;
  return models.map((model) => ({
    id: model.id,
    label: model.label.slice(0, MODEL_LABEL_MAX),
    ...(model.efforts === undefined
      ? {}
      : {
          efforts:
            model.efforts === null
              ? null
              : model.efforts.map((level) => ({
                  id: level.id,
                  // Подпись строит Parley, как для `providers.json`: ручная правка кэша не растянет окно.
                  label: effortLabel(level.id),
                  ...(level.description === undefined
                    ? {}
                    : { description: level.description.slice(0, EFFORT_DESCRIPTION_MAX) }),
                })),
        }),
  }));
}

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
    (patch['assistantArgs'] !== undefined && !isStrings(patch['assistantArgs'])) ||
    (patch['assistantResumeArgs'] !== undefined && !isStrings(patch['assistantResumeArgs'])) ||
    (patch['models'] !== undefined && !isModelList(patch['models'])) ||
    (patch['mcpConfig'] !== undefined &&
      patch['mcpConfig'] !== 'json-file' &&
      patch['mcpConfig'] !== 'codex-override');
  if (wrong) throw new Error(`provider ${id} in ${file}: unexpected entry shape`);
  // Уровни моделей — с причиной: их правят руками, и «unexpected entry shape» не сказал бы, что не так.
  for (const model of (patch['models'] ?? []) as Array<{ id: string; efforts?: unknown }>) {
    if (model.efforts !== undefined && !isEffortList(model.efforts)) {
      throw new Error(
        `provider ${id} in ${file}: model ${model.id}: efforts must be null or a non-empty list of unique levels (lowercase letters, digits, - and _, up to 32 characters)`,
      );
    }
  }
}

/** Накладывает переопределение на запись встроенного реестра (или создаёт свою). */
function applyOverride(
  id: string,
  file: string,
  patch: ProviderOverride,
  base: ProviderEntry | undefined,
): ProviderEntry {
  // Префиксы принадлежат окну: `custom-` — своим провайдерам и аккаунтам Claude (спека своих провайдеров, 5.3),
  // `codex-` — аккаунтам Codex (спека подписок 5.1, К8). Руками их не занять.
  if (base === undefined && isManagedProviderId(id)) {
    throw new Error(`provider ${id} in ${file}: the custom- and codex- prefixes are reserved`);
  }
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
  const assistantArgs = patch.assistantArgs ?? base?.runner.assistantArgs;
  const assistantResumeArgs = patch.assistantResumeArgs ?? base?.runner.assistantResumeArgs;
  if (assistantArgs !== undefined) runner.assistantArgs = assistantArgs;
  if (assistantResumeArgs !== undefined) runner.assistantResumeArgs = assistantResumeArgs;
  if (mcpConfig !== undefined) runner.mcpConfig = mcpConfig;

  // Из файла в запись ложатся свои копии пар, а не объекты разобранного JSON; уровни в файле — id,
  // в записи — с подписями, как у встроенного каталога.
  const models =
    patch.models === undefined
      ? base?.models
      : patch.models.map((model) => ({
          id: model.id,
          label: model.label,
          ...(model.efforts === undefined
            ? {}
            : {
                efforts:
                  model.efforts === null
                    ? null
                    : model.efforts.map((effort) => ({ id: effort, label: effortLabel(effort) })),
              }),
        }));
  return {
    id,
    ...(base?.family === undefined ? {} : { family: base.family }),
    label,
    mark: patch.mark ?? base?.mark ?? label.slice(0, 2),
    hasHistory: patch.hasHistory ?? base?.hasHistory ?? false,
    linkBy: patch.linkBy ?? base?.linkBy ?? 'cwd+time',
    runner,
    ...(models === undefined ? {} : { models }),
    ...(patch.args === undefined ? {} : { argsOverridden: true as const }),
  };
}

/**
 * Встроенный реестр плюс необязательные переопределения из
 * `providers.json` дома (`parleyHome()`): merge по id, свои провайдеры добавляются.
 * Битый файл — ошибка: реестр пишем не мы, но догадываться о его форме нельзя,
 * иначе харнесс молча запустит не то, что просил пользователь. Модели `codex` до
 * `providers.json` берутся из каталога хоста (`codexModelsFile`), если он есть и цел.
 */
export async function loadProviders(
  file = providersFile(),
  codexFile = codexModelsFile(),
  customFile = customProvidersFile(),
): Promise<Record<WorkProvider, ProviderEntry>> {
  const registry = await loadBaseProviders(file, codexFile);
  // Свои провайдеры (спека 5.3) и аккаунты подписок (спека подписок 5.2) — после providers.json; занятый id
  // (встроенный или из файла) не перекрывают. Аккаунту нужна запись `claude` уже со всеми переопределениями.
  for (const record of await readCustomProviders(customFile)) {
    if (Object.hasOwn(registry, record.id)) continue;
    if (!isAccountRecord(record)) registry[record.id] = customProviderEntry(record);
    // Аккаунт Codex — этап 3: хост до тех пор такую запись не создаёт, а чужую пропускаем молча.
    else if (record.kind === 'claude-account') registry[record.id] = accountProviderEntry(record, registry);
  }
  return registry;
}

async function loadBaseProviders(
  file: string,
  codexFile: string,
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

  // Живой каталог Codex — раньше `providers.json`: свой список человека важнее обоих (спека нормалайзера, 5.2).
  const codex = registry['codex'];
  const live = await readCodexModels(codexFile);
  if (codex !== undefined && live !== null) registry['codex'] = { ...codex, models: live };

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
