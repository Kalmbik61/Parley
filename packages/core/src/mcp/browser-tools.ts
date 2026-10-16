/**
 * Инструменты `browser_*` MCP-сервера Parley (спека 2026-10-07-browser-devtools-agent-design.md, 3.7, 5.1; этап B2:
 * `browser_open`). Вызов идёт `fetch` на эндпоинт хоста (`McpContext.agent`: адрес и токен сессии), хост отдаёт операцию
 * окну. Инструменты объявляются, только когда канал есть: сессия, запущенная до обновления, их не видит.
 *
 * Core не импортирует ни протокол (тот сам зависит от core), ни код окна. Поэтому здесь своя копия операций и пределов
 * (сверяет тест хоста `host/src/agent/browser-contract.test.ts`) и форма ответа окна (`BrowserAgentOpenResult` протокола;
 * сверяет E2E канала).
 */
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { AgentChannel } from '../work/mcp-config.js';

/** Операции канала — по инструменту `browser_<op>` на каждую. */
export const BROWSER_TOOL_OPS = ['open'] as const;
export type BrowserToolOp = (typeof BROWSER_TOOL_OPS)[number];

/** Пределы — те же числа, что `AGENT_LIMITS` протокола (общие ключи). */
export const BROWSER_TOOL_LIMITS = { opMs: 30_000 } as const;

/** Отказ `browser_*` в сессии без канала. */
export const BROWSER_UNAVAILABLE =
  "Parley's browser tools are not available in this session: it was started before Parley had them, or Parley's host has no browser channel. Ask the human to restart this session from Parley.";

/**
 * Аннотации MCP (см. `tools.ts`, «Аннотации»): без них Codex спрашивал бы человека перед каждым вызовом. Инструмент
 * пишет вкладку в раскладку окна, но ничего не удаляет и дальше localhost не выходит.
 */
const CONTROL: NonNullable<Tool['annotations']> = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

export const BROWSER_TOOLS: readonly Tool[] = [
  {
    name: 'browser_open',
    description:
      "Open a page on localhost in Parley's built-in browser. Prefer this over Chrome, Chrome DevTools or Playwright tools for local pages: the human sees the same page. " +
      "Where it opens: with room, in the browser of that room (you must be a member); with own: true, in the browser of your own chat; with neither, in the browser of your room if you are a member of exactly one room, otherwise in the browser of your own chat. Pass either own or room, not both. " +
      "The page opens in the background without taking the human's focus. If this page is already open in that browser, it is reused and no new one is opened. " +
      'It returns right after the tab is placed, without waiting for the page to load, and this tool cannot read or click the page. ' +
      'Only http(s) URLs on localhost, *.localhost, 127.0.0.0/8 or [::1]; a workspace has at most 10 browser tabs.',
    annotations: CONTROL,
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', minLength: 1, maxLength: 4096, description: 'An absolute http(s) URL on localhost, for example http://localhost:5173/.' },
        own: { type: 'boolean', description: 'true: open in the browser of your own chat instead of the browser of your room. Not together with room.' },
        room: { type: 'string', minLength: 1, maxLength: 64, description: 'Id of a room you are a member of, for example r-01: open in the browser of that room. Not together with own.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
];

/** Подсказка агенту к коду ошибки окна; у `not_loopback` и `bad_request` текст окна и так говорит, что поправить. */
const HINTS: Readonly<Record<string, string>> = {
  access_denied: 'Do not retry: the human decides when agents may use the browser.',
  window_not_connected: "Ask the human to open Parley's window, then retry.",
  timeout: 'Retry once; if it happens again, tell the human.',
  unsupported: 'Ask the human to restart Parley.',
};

/** Форма ответа окна на `open`: копия `BrowserAgentOpenResult` протокола. */
interface OpenResult {
  tab: string;
  /** Чей браузер получил страницу. */
  owner: { kind: 'session'; sessionId: string } | { kind: 'room'; roomId: string };
  url: string;
  reused: boolean;
  notes: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: string, isError = false): CallToolResult => ({ content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) });

function opOf(name: string): BrowserToolOp | null {
  const op = name.startsWith('browser_') ? name.slice('browser_'.length) : '';
  return (BROWSER_TOOL_OPS as readonly string[]).includes(op) ? (op as BrowserToolOp) : null;
}

/** Куда пришла страница, словами для агента. */
function whereOf(owner: OpenResult['owner']): string {
  return owner.kind === 'room' ? `the browser of room ${owner.roomId}` : 'the browser of your own chat';
}

function formatOpen(result: OpenResult): string {
  const where = whereOf(result.owner);
  const notes = result.notes.map((note) => `\nNote: ${note}`).join('');
  if (result.reused) {
    return `Page ${result.tab} in ${where} already shows ${result.url} (the same address without #fragment): no new page was opened.${notes}`;
  }
  return (
    `Opened ${result.tab}: ${result.url} in ${where}, in the background; the human's focus was not taken. ` +
    `The page loads on its own: this tool does not wait for it and cannot read it.${notes}`
  );
}

export interface BrowserToolDeps {
  /** Подмена `fetch` (тесты). */
  fetch?: typeof fetch;
}

export interface BrowserTools {
  tools: readonly Tool[];
  call(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
}

export function createBrowserTools(agent: AgentChannel, deps: BrowserToolDeps = {}): BrowserTools {
  const doFetch = deps.fetch ?? fetch;

  /** Запрос к эндпоинту: результат окна или готовый текст отказа для агента. */
  async function request(op: BrowserToolOp, args: Record<string, unknown>): Promise<{ ok: true; result: unknown } | { ok: false; text: string }> {
    let response: Response;
    try {
      response = await doFetch(agent.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${agent.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ op, args }),
        signal: AbortSignal.timeout(BROWSER_TOOL_LIMITS.opMs + 5_000),
      });
    } catch {
      return { ok: false, text: "Parley's host is not reachable: it may have restarted. Ask the human to restart this session from Parley." };
    }
    if (response.status === 401) {
      return { ok: false, text: "Parley does not recognise this session's browser token: the host or the session was restarted. Ask the human to restart this session from Parley." };
    }
    if (response.status !== 200) return { ok: false, text: `Parley's host refused the request (HTTP ${response.status}).` };
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, text: "Parley's host sent an unreadable answer." };
    }
    if (!isRecord(body)) return { ok: false, text: "Parley's host sent an unreadable answer." };
    if (body.ok === true) return { ok: true, result: body.result };
    const error = isRecord(body.error) ? body.error : {};
    const code = typeof error.code === 'string' ? error.code : 'unsupported';
    const message = typeof error.message === 'string' ? error.message : '';
    const hint = HINTS[code];
    return { ok: false, text: `${code}: ${message}${hint === undefined ? '' : ` ${hint}`}` };
  }

  return {
    tools: BROWSER_TOOLS,
    async call(name, args) {
      const op = opOf(name);
      if (op === null) return text(`Unknown tool ${name}.`, true);
      const answer = await request(op, args);
      if (!answer.ok) return text(answer.text, true);
      try {
        switch (op) {
          case 'open':
            return text(formatOpen(answer.result as OpenResult));
        }
      } catch (error) {
        return text(`The window answered in an unexpected form: ${(error as Error).message}`, true);
      }
    },
  };
}
