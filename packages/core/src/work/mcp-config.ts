import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpConfigKind } from '../providers.js';
import { CODEX_NOTIFY_ENTRY } from './codex-notify.js';
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

/** Имя сервера в конфиге: под ним агент видит инструменты как `mcp__harnas__*`. */
export const MCP_SERVER_NAME = 'harnas';

export interface McpConfigParams {
  /** Путь к `.harnas/works/<work-id>/` — переменная `HARNAS_WORK_DIR` сервера. */
  workDir: string;
  /** Id сессии в карте — переменная `HARNAS_SESSION_ID`. */
  sessionId: string;
  /** Чем запускать сервер; по умолчанию node и скрипт сервера по абсолютному пути. */
  command?: string;
  /**
   * Будить ли сессию звонком: `HARNAS_CHANNEL` включает у сервера сторожа
   * входящих (разговор агентов, 4.4). Без флага канала у агента звонить некуда,
   * поэтому переменную ставит только тот, кто этот флаг передал.
   */
  channel?: boolean;
  /**
   * Окружение запускающего процесса (хоста). Нужно только Codex: он отдаёт серверу урезанное
   * окружение (HOME, PATH и ещё несколько), поэтому нужные серверу `HARNAS_*` — дом харнесса,
   * подмены бинарей — кладутся в его таблицу `env` явно. Claude Code передаёт серверу окружение
   * целиком, ему это не нужно. Не задано — переносить нечего, и в таблице только две своих.
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
 * раздел 4).
 */
export function mcpConfig({
  workDir,
  sessionId,
  command,
  channel,
}: McpConfigParams): McpConfigFile {
  return {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: 'stdio',
        ...serverLaunch(command),
        env: {
          HARNAS_WORK_DIR: workDir,
          HARNAS_SESSION_ID: sessionId,
          ...(channel === true ? { HARNAS_CHANNEL: '1' } : {}),
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
 * инструментов `harnas` (сбой запуска сервера Codex не считает фатальным). Ответ — дольше самого
 * долгого `wait_for` (`MAX_TIMEOUT_SEC` в `mcp/tools.ts`, 30 минут) и ещё минута сверху: иначе клиент
 * оборвал бы ожидание письма через минуту. Тест сверяет второе число с `MAX_TIMEOUT_SEC`.
 */
export const CODEX_MCP_STARTUP_TIMEOUT_SEC = 30;
export const CODEX_MCP_TOOL_TIMEOUT_SEC = 30 * 60 + 60;

/** Переменные, которые сервер получает из окружения запускающего: только наше пространство имён. */
const HARNAS_VARIABLE = /^HARNAS_[A-Z0-9_]+$/;
/** Три переменные, которые харнесс задаёт сессии сам: унаследованное значение их не перекрывает. */
const SESSION_VARIABLES = new Set(['HARNAS_WORK_DIR', 'HARNAS_SESSION_ID', 'HARNAS_CHANNEL']);

/** Пары `имя=значение` таблицы `env` сервера: сначала адрес сессии, затем унаследованные `HARNAS_*`. */
function codexServerEnv({
  workDir,
  sessionId,
  env,
}: Pick<McpConfigParams, 'workDir' | 'sessionId' | 'env'>): Array<[string, string]> {
  const inherited = Object.entries(env ?? {})
    .filter(
      (entry): entry is [string, string] =>
        HARNAS_VARIABLE.test(entry[0]) &&
        !SESSION_VARIABLES.has(entry[0]) &&
        typeof entry[1] === 'string' &&
        entry[1] !== '',
    )
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return [['HARNAS_WORK_DIR', workDir], ['HARNAS_SESSION_ID', sessionId], ...inherited];
}

/**
 * Тот же сервер значением для `codex -c`: файла-конфига MCP у codex нет,
 * серверы живут в `~/.codex/config.toml`, а `-c mcp_servers.<имя>=<таблица>`
 * добавляет свой, не трогая файл пользователя.
 *
 * Окружение сервера Codex урезает, поэтому всё, что нужно `parley-mcp`, лежит в таблице `env`
 * (`codexServerEnv`). `channel` здесь не учитывается: звонок — возможность Claude Code, codex
 * живёт по pull (разговор агентов, 4.4).
 */
export function codexMcpOverride(params: McpConfigParams): string {
  const env = `{${codexServerEnv(params)
    .map(([name, value]) => `${name}=${tomlString(value)}`)
    .join(',')}}`;
  const launch = serverLaunch(params.command);
  const args = `[${launch.args.map(tomlString).join(',')}]`;
  return (
    `mcp_servers.${MCP_SERVER_NAME}={command=${tomlString(launch.command)},args=${args},env=${env},` +
    `startup_timeout_sec=${CODEX_MCP_STARTUP_TIMEOUT_SEC},tool_timeout_sec=${CODEX_MCP_TOOL_TIMEOUT_SEC}}`
  );
}

/**
 * `-c notify=[<node>, <скрипт>]`: после каждого хода Codex запускает скрипт и отдаёт ему JSON
 * `agent-turn-complete` последним аргументом. Скрипт дописывает `Stop` в журнал событий сессии
 * (`work/codex-notify.ts`). Программу Codex запускает без оболочки, поэтому пути — элементами
 * массива, а node — текущего процесса, как у сервера MCP и строки статуса.
 */
export function codexNotifyOverride(): string {
  return `notify=[${tomlString(process.execPath)},${tomlString(CODEX_NOTIFY_ENTRY)}]`;
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
): Promise<string> {
  const paths = workPaths(projectPath, workId);
  const file = path.join(paths.mcp, `${sessionId}.json`);
  await mkdir(paths.mcp, { recursive: true });
  await writeFile(
    file,
    mcpConfigJson({
      workDir: paths.dir,
      sessionId,
      ...(command === undefined ? {} : { command }),
      ...(channel ? { channel } : {}),
    }),
    'utf8',
  );
  return file;
}
