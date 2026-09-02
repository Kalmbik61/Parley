import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { McpConfigKind } from '../providers.js';
import { workPaths } from './store.js';

/** Имя bin MCP-сервера в `packages/core/package.json`. */
export const MCP_SERVER_BIN = 'harnas-mcp';

/** Имя сервера в конфиге: под ним агент видит инструменты как `mcp__harnas__*`. */
export const MCP_SERVER_NAME = 'harnas';

export interface McpConfigParams {
  /** Путь к `.harnas/works/<work-id>/` — переменная `HARNAS_WORK_DIR` сервера. */
  workDir: string;
  /** Id сессии в карте — переменная `HARNAS_SESSION_ID`. */
  sessionId: string;
  /** Чем запускать сервер; по умолчанию bin из PATH. */
  command?: string;
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
 * Конфиг MCP на одну сессию: сервер `harnas-mcp` по stdio, а кто звонит — он
 * узнаёт из окружения, поэтому агенту не нужно представляться (спецификация,
 * раздел 4).
 */
export function mcpConfig({ workDir, sessionId, command }: McpConfigParams): McpConfigFile {
  return {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: 'stdio',
        command: command ?? MCP_SERVER_BIN,
        args: [],
        env: { HARNAS_WORK_DIR: workDir, HARNAS_SESSION_ID: sessionId },
      },
    },
  };
}

/** Содержимое файла для `claude --mcp-config`. */
export function mcpConfigJson(params: McpConfigParams): string {
  return `${JSON.stringify(mcpConfig(params), null, 2)}\n`;
}

/** Строка TOML: экранирование базовой строки совпадает с JSON для наших значений. */
const tomlString = (value: string): string => JSON.stringify(value);

/**
 * Тот же сервер значением для `codex -c`: файла-конфига MCP у codex нет,
 * серверы живут в `~/.codex/config.toml`, а `-c mcp_servers.<имя>=<таблица>`
 * добавляет свой, не трогая файл пользователя.
 */
export function codexMcpOverride({ workDir, sessionId, command }: McpConfigParams): string {
  const env = `env={HARNAS_WORK_DIR=${tomlString(workDir)},HARNAS_SESSION_ID=${tomlString(sessionId)}}`;
  return `mcp_servers.${MCP_SERVER_NAME}={command=${tomlString(command ?? MCP_SERVER_BIN)},args=[],${env}}`;
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
): Promise<string> {
  const paths = workPaths(projectPath, workId);
  const file = path.join(paths.mcp, `${sessionId}.json`);
  await mkdir(paths.mcp, { recursive: true });
  await writeFile(
    file,
    mcpConfigJson(
      command === undefined
        ? { workDir: paths.dir, sessionId }
        : { workDir: paths.dir, sessionId, command },
    ),
    'utf8',
  );
  return file;
}
