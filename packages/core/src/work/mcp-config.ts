import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bothEnv, ENV_PREFIX, LEGACY_ENV_PREFIX, MCP_SERVER_NAME } from '../names.js';
import type { McpConfigKind } from '../providers.js';
import { ensureStateDir } from './state-dir.js';
import { workPaths } from './store.js';

/** Имя bin MCP-сервера в `packages/core/package.json`. */
export const MCP_SERVER_BIN = 'parley-mcp';

/** Скрипт сервера по абсолютному пути — лежит рядом с этим модулем, в `mcp/`. */
export const MCP_SERVER_ENTRY = fileURLToPath(new URL('../mcp/server.js', import.meta.url));

/**
 * Чем запускать сервер. Bin `parley-mcp` есть в PATH только под pnpm-скриптами,
 * а агент стартует из любого терминала — поэтому по умолчанию берём node текущего
 * процесса и скрипт по абсолютному пути. Явная команда остаётся как есть.
 */
function serverLaunch(command?: string): { command: string; args: string[] } {
  return command === undefined
    ? { command: process.execPath, args: [MCP_SERVER_ENTRY] }
    : { command, args: [] };
}

/** Канал агента к браузеру окна (спека браузера 2026-10-07, 3.7): адрес эндпоинта хоста и токен запуска сессии. */
export interface AgentChannel {
  /** `http://127.0.0.1:<порт>/agent/browser`. */
  url: string;
  /** 32 байта hex; новый на каждый запуск сессии. */
  token: string;
}

/** Переменные канала у MCP-сервера — только под новыми именами: у прежних сборок канала не было. */
export const AGENT_URL_ENV = 'PARLEY_AGENT_URL';
export const AGENT_TOKEN_ENV = 'PARLEY_AGENT_TOKEN';

const agentEnv = (agent: AgentChannel | undefined): Record<string, string> =>
  agent === undefined ? {} : { [AGENT_URL_ENV]: agent.url, [AGENT_TOKEN_ENV]: agent.token };

export interface McpConfigParams {
  /** Путь к `<проект>/.parley/works/<work-id>/` — переменная `PARLEY_WORK_DIR` сервера (и прежняя `HARNAS_WORK_DIR`). */
  workDir: string;
  skillNavigator?: boolean;
  /** Родной список скиллов этого запуска сокращён: сервер объявляет это в описании `find_skill`. Только `true` попадает в окружение. */
  skillListReduced?: boolean;
  nativeContextRevision?: string;
  /**
   * Канал агента к браузеру окна (спека браузера 3.7): с ним сервер объявляет инструмент `browser_open`. Хост выдаёт его
   * каждому запуску; нет — старый хост или сервер хуков не поднялся, и инструментов браузера у сессии нет.
   */
  agent?: AgentChannel;
  /** Id сессии в карте — переменная `PARLEY_SESSION_ID` (и прежняя `HARNAS_SESSION_ID`). */
  sessionId: string;
  /** Чем запускать сервер; по умолчанию node и скрипт сервера по абсолютному пути. */
  command?: string;
  /**
   * Будить ли сессию звонком: `PARLEY_CHANNEL` (и прежняя `HARNAS_CHANNEL`) включает у сервера сторожа
   * входящих (разговор агентов, 4.4). Без флага канала у агента звонить некуда,
   * поэтому переменную ставит только тот, кто этот флаг передал.
   */
  channel?: boolean;
  /**
   * Окружение запускающего процесса (хоста). Нужно только Codex: он отдаёт серверу урезанное
   * окружение (HOME, PATH и ещё несколько), поэтому нужные серверу `PARLEY_*` и `HARNAS_*` — дом харнесса,
   * подмены бинарей — кладутся в его таблицу `env` явно. Claude Code передаёт серверу окружение
   * целиком, ему это не нужно. Не задано — переносить нечего, и в таблице только свои сессионные.
   */
  env?: NodeJS.ProcessEnv;
}

export interface McpStdioServer {
  type: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface McpConfigFile {
  mcpServers: Record<string, McpStdioServer>;
}

/**
 * Конфиг MCP на одну сессию: сервер `parley-mcp` по stdio, а кто звонит — он
 * узнаёт из окружения, поэтому агенту не нужно представляться (спецификация,
 * раздел 4). Под именем `MCP_SERVER_NAME` (`names.ts`) агент видит инструменты как `mcp__parley__*`;
 * сервер в конфиге один — под прежним именем второго не регистрируется. Сессионные переменные уходят
 * под обоими именами (`PARLEY_*` и `HARNAS_*`, R3): сервер читает новые, а старый `parley-mcp`
 * (сохранённый конфиг, чужая сборка) — прежние.
 */
export function mcpConfig({
  workDir,
  sessionId,
  command,
  channel,
  skillNavigator,
  skillListReduced,
  nativeContextRevision,
  agent,
}: McpConfigParams): McpConfigFile {
  return {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: 'stdio',
        ...serverLaunch(command),
        env: {
          ...bothEnv({
            WORK_DIR: workDir,
            SESSION_ID: sessionId,
            ...(channel === true ? { CHANNEL: '1' } : {}),
            ...(skillNavigator === undefined ? {} : { SKILL_NAVIGATOR: skillNavigator ? '1' : '0' }),
            ...(skillListReduced === true ? { SKILL_LIST_REDUCED: '1' } : {}),
            ...(nativeContextRevision === undefined ? {} : { NATIVE_CONTEXT_REVISION: nativeContextRevision }),
          }),
          ...agentEnv(agent),
        },
      },
    },
  };
}

/** Содержимое файла для `claude --mcp-config`. */
export function mcpConfigJson(params: McpConfigParams): string {
  return `${JSON.stringify(mcpConfig(params), null, 2)}\n`;
}

/** Одиночный суррогат UTF-16: старший без младшего следом или младший без старшего перед ним. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * Базовая строка TOML для значения `-c`. Экранирование JSON почти совпадает с TOML, но не полностью,
 * а Codex разбирает `-c` мягко: значение, не разобравшееся как TOML, он молча берёт обычной строкой,
 * и таблица сервера превратилась бы в текст без единой ошибки. Два расхождения закрыты здесь:
 * - DEL (U+007F) TOML в строке сырым не терпит, JSON его не экранирует — он идёт как `\u007f`;
 * - одиночный суррогат JSON пишет как `\ud83d`, а TOML принимает в `\u` только скаляры Unicode —
 *   такой знак заменяется на U+FFFD (в путях и окружении он бывает разве что от битой кодировки).
 * Остальное — кавычки, обратный слеш, управляющие знаки, любой юникод — общее у обоих форматов.
 */
export const tomlString = (value: string): string =>
  JSON.stringify(value.replace(LONE_SURROGATE, '�')).replaceAll('\u007f', '\\u007f');

/**
 * Сколько Codex ждёт запуск сервера (по умолчанию 10 с) и ответ инструмента (по умолчанию 60 с).
 * Запуск — с запасом: медленный старт `node` под нагрузкой не должен молча оставить агента без
 * инструментов `parley` (сбой запуска сервера Codex не считает фатальным). Ответ — дольше самого
 * долгого `wait_for` (`MAX_TIMEOUT_SEC` в `mcp/tools.ts`, 30 минут) и ещё минута сверху: иначе клиент
 * оборвал бы ожидание письма через минуту. Тест сверяет второе число с `MAX_TIMEOUT_SEC`.
 */
export const CODEX_MCP_STARTUP_TIMEOUT_SEC = 30;
export const CODEX_MCP_TOOL_TIMEOUT_SEC = 30 * 60 + 60;

/** Переменные, которые сервер получает из окружения запускающего: только наше пространство имён, оба префикса. */
const OWN_VARIABLE = new RegExp(`^(?:${ENV_PREFIX}|${LEGACY_ENV_PREFIX})[A-Z0-9_]+$`);
/**
 * Переменные, которые харнесс задаёт сессии сам, под обоими именами: унаследованное значение их не перекрывает. Канал
 * агента — тоже только свой: хост, поднятый из сессии агента, унаследовал бы её адрес и токен.
 */
const SESSION_VARIABLES = new Set([
  ...Object.keys(bothEnv({ WORK_DIR: '', SESSION_ID: '', CHANNEL: '', SKILL_NAVIGATOR: '', SKILL_LIST_REDUCED: '', NATIVE_CONTEXT_REVISION: '' })),
  ...Object.keys(bothEnv({ AGENT_URL: '', AGENT_TOKEN: '' })),
]);

/** Пары `имя=значение` таблицы `env` сервера: сначала адрес сессии под обоими именами, затем унаследованные `PARLEY_*` и `HARNAS_*`. */
function codexServerEnv({
  workDir,
  sessionId,
  env,
  skillNavigator,
  skillListReduced,
  nativeContextRevision,
  agent,
}: Pick<McpConfigParams, 'workDir' | 'sessionId' | 'env' | 'skillNavigator' | 'skillListReduced' | 'nativeContextRevision' | 'agent'>): Array<[string, string]> {
  const inherited = Object.entries(env ?? {})
    .filter(
      (entry): entry is [string, string] =>
        OWN_VARIABLE.test(entry[0]) &&
        !SESSION_VARIABLES.has(entry[0]) &&
        typeof entry[1] === 'string' &&
        entry[1] !== '',
    )
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return [...Object.entries(bothEnv({ WORK_DIR: workDir, SESSION_ID: sessionId,
    ...(skillNavigator === undefined ? {} : { SKILL_NAVIGATOR: skillNavigator ? '1' : '0' }),
    ...(skillListReduced === true ? { SKILL_LIST_REDUCED: '1' } : {}),
    ...(nativeContextRevision === undefined ? {} : { NATIVE_CONTEXT_REVISION: nativeContextRevision }),
  })), ...Object.entries(agentEnv(agent)), ...inherited];
}

/**
 * Тот же сервер значением для `codex -c`: файла-конфига MCP у codex нет,
 * серверы живут в `~/.codex/config.toml`, а `-c mcp_servers.<имя>=<таблица>`
 * добавляет свой, не трогая файл пользователя.
 *
 * Окружение сервера Codex урезает, поэтому всё, что нужно `parley-mcp`, лежит в таблице `env`
 * (`codexServerEnv`). `channel` здесь не учитывается: звонок — возможность Claude Code, codex
 * живёт по pull (разговор агентов, 4.4).
 *
 * `default_tools_approval_mode = "approve"` — Codex вызывает любой инструмент `parley` без вопроса, в том числе
 * `browser_evaluate`, `browser_cookies` и `browser_storage` (решение владельца 2026-10-21; Claude Code по-прежнему
 * спрашивает про эти три — `settings-file.ts`). Таблицы `tools` по инструментам здесь нет: её `approval_mode` перекрыл бы
 * общий режим. `-c` Codex сливает с файлом по ключам, и свой ключ сильнее ключа из личного `config.toml` человека
 * (проба `codex mcp get` 0.162 с временным `CODEX_HOME`, 2026-10-20).
 */
export function codexMcpOverride(params: McpConfigParams): string {
  const env = `{${codexServerEnv(params)
    .map(([name, value]) => `${name}=${tomlString(value)}`)
    .join(',')}}`;
  const launch = serverLaunch(params.command);
  const args = `[${launch.args.map(tomlString).join(',')}]`;
  return (
    `mcp_servers.${MCP_SERVER_NAME}={command=${tomlString(launch.command)},args=${args},env=${env},` +
    `default_tools_approval_mode="approve",` +
    `startup_timeout_sec=${CODEX_MCP_STARTUP_TIMEOUT_SEC},tool_timeout_sec=${CODEX_MCP_TOOL_TIMEOUT_SEC}}`
  );
}

/** Значение подстановки `{mcpConfig}` для записи реестра. */
export function mcpConfigValue(
  kind: McpConfigKind | undefined,
  params: McpConfigParams,
  configFile: string,
): string | undefined {
  if (kind === 'json-file') return configFile;
  if (kind === 'codex-override') return codexMcpOverride(params);
  return undefined;
}

/** Пишет конфиг сессии в `mcp/<session-id>.json` работы и возвращает путь к нему. */
export async function writeMcpConfig(
  projectPath: string,
  workId: string,
  sessionId: string,
  command?: string,
  channel = false,
  snapshot: Pick<McpConfigParams, 'skillNavigator' | 'skillListReduced' | 'nativeContextRevision' | 'agent'> = {},
): Promise<string> {
  const paths = workPaths(projectPath, workId);
  const file = path.join(paths.mcp, `${sessionId}.json`);
  await ensureStateDir(projectPath);
  await mkdir(paths.mcp, { recursive: true });
  await writeFile(
    file,
    mcpConfigJson({
      ...snapshot,
      workDir: paths.dir,
      sessionId,
      ...(command === undefined ? {} : { command }),
      ...(channel ? { channel } : {}),
    }),
    { encoding: 'utf8', mode: 0o600 },
  );
  // В файле — токен канала агента: читать его может только сам человек. `mode` у `writeFile` действует лишь при
  // создании, а файл переписывается на каждом запуске, и прежний мог лечь с 0644, — права ставятся явно.
  await chmod(file, 0o600);
  return file;
}
