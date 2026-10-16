/**
 * Запуск хода помощника (спека 2026-10-14, 6.1–6.4): модели по умолчанию, минимальные версии CLI, конфиг его MCP
 * для Claude (файл) и Codex (`-c`), системный промпт.
 */

import { MCP_SERVER_ENTRY } from '../work/mcp-config.js';
import { ASSISTANT_MCP_NAME } from './stream.js';
import type { AssistantLanguage } from './text.js';

/** Быстрые модели по умолчанию (спека 6.1). */
export const ASSISTANT_DEFAULT_MODELS: Readonly<Record<string, string>> = {
  claude: 'haiku',
  glm: 'glm-5.3-flash[1m]',
  codex: 'gpt-6-luna',
};

/** Провайдер не выбран — первый готовый в этом порядке. */
export const ASSISTANT_PROVIDER_ORDER: readonly string[] = ['claude', 'glm', 'codex'];

/** Проверено спайком (приложение A); по имени команды CLI. */
export const ASSISTANT_MIN_VERSIONS: Readonly<Record<string, string>> = { claude: '2.1.300', codex: '0.162.0' };

/** `found` — вывод `--version`; версии в нём не нашлось — не отказываем. */
export function versionAtLeast(found: string, min: string): boolean {
  const have = /(\d+)\.(\d+)\.(\d+)/.exec(found);
  const need = /(\d+)\.(\d+)\.(\d+)/.exec(min);
  if (have === null || need === null) return true;
  for (let index = 1; index <= 3; index += 1) {
    const delta = Number(have[index]) - Number(need[index]);
    if (delta !== 0) return delta > 0;
  }
  return true;
}

export interface AssistantMcpParams {
  /** База маршрута хоста, например `http://127.0.0.1:5123/assistant`. */
  url: string;
  token: string;
  /** Для тестов; по умолчанию — node хоста и `mcp/server.js` из бандла, как у MCP сессий. */
  command?: string;
  args?: string[];
}

function launch(params: AssistantMcpParams): { command: string; args: string[] } {
  return { command: params.command ?? process.execPath, args: params.args ?? [MCP_SERVER_ENTRY] };
}

/** Файл `--mcp-config` для Claude и GLM. */
export function assistantMcpJson(params: AssistantMcpParams): string {
  const { command, args } = launch(params);
  const server = {
    type: 'stdio',
    command,
    args,
    env: { PARLEY_ASSISTANT_URL: params.url, PARLEY_ASSISTANT_TOKEN: params.token },
  };
  return `${JSON.stringify({ mcpServers: { [ASSISTANT_MCP_NAME]: server } }, null, 2)}\n`;
}

/** Значение `-c` для Codex: TOML-таблица в одну строку; JSON-экранирование строк годится TOML. */
export function assistantCodexMcp(params: AssistantMcpParams): string {
  const { command, args } = launch(params);
  const toml = (value: string): string => JSON.stringify(value);
  return (
    `mcp_servers.${ASSISTANT_MCP_NAME}={command=${toml(command)},args=[${args.map(toml).join(',')}],` +
    `env={PARLEY_ASSISTANT_URL=${toml(params.url)},PARLEY_ASSISTANT_TOKEN=${toml(params.token)}},` +
    `default_tools_approval_mode="approve",startup_timeout_sec=30,tool_timeout_sec=60}`
  );
}

/** Значение `-c` для Codex: базовый промпт заменён файлом помощника (приложение A.2 — ~10 тыс. токенов дешевле). */
export function codexInstructionsFile(file: string): string {
  return `model_instructions_file=${JSON.stringify(file)}`;
}

const LANGUAGE_NAMES: Readonly<Record<AssistantLanguage, string>> = { en: 'English', ru: 'Russian' };

/** Системный промпт помощника (спека 6.4). */
export function assistantPrompt(language: AssistantLanguage): string {
  return [
    'You are the Parley assistant: a navigator for one person who runs several AI coding agents in Parley.',
    'Parley groups agents into works inside projects; a work has sessions (agents) and rooms (group chats of agents).',
    'You answer the person about what their agents, works and rooms are doing, and you pass their messages on.',
    '',
    'Rules:',
    `- Reply in ${LANGUAGE_NAMES[language]}, even if the person wrote in another language.`,
    '- Your reply is read on a small panel and may be spoken aloud: 1-4 short spoken sentences. No markdown, lists, file paths, code or ids.',
    '- Start every reply with one mood tag: [[calm]] [[joy]] [[sad]] [[surprise]] [[anger]], matching the news. Then the reply.',
    '- For anything about the current state call parley_overview first, every time. For one room or session call parley_detail with an id from the overview. Never answer about state from memory and never guess; if the tools do not say, say you do not know.',
    '- To pass a message to a room or an agent, call propose_message with the target id and the exact text to send. You never send anything yourself: the person sees a card and confirms or cancels it. After proposing, say in one short sentence what you prepared; do not repeat the text.',
    '- If the person asks to start over or for a new conversation, call end_conversation and say so briefly.',
    '- Lines that start with [system: ...] come from Parley, not from the person.',
    '- You cannot approve agent requests, start or stop sessions, or create rooms. If asked, say that this is not available yet.',
  ].join('\n');
}
