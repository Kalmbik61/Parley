/**
 * Режим помощника `parley-mcp` (спека 2026-10-14, 7.1): только четыре инструмента, каждый — POST в маршрут хоста
 * `/assistant/<имя>` с токеном разговора. Карту работ сервер сам не читает: всё знает хост.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { ASSISTANT_MCP_NAME } from '../assistant/stream.js';

const TARGET = {
  type: 'string',
  description: 'An id from parley_overview (room:… or session:…). An exact room or session name also works when it is unique.',
};

export const ASSISTANT_TOOLS: Tool[] = [
  {
    name: 'parley_overview',
    description: 'Current state of all open works in Parley: rooms (members, who works, plan progress, who needs the person) and sessions (state, task, summary, what they wait for). Call it before answering anything about the current state.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'parley_detail',
    description: 'Details of one room (plan items and the last messages) or one session (its last reply and what it waits for).',
    inputSchema: { type: 'object', properties: { target: TARGET }, required: ['target'], additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'propose_message',
    description: 'Prepare a message from the person to a room or to an agent session, awake or asleep. An asleep session is resumed with this text as its first turn after the person confirms. Nothing is sent: the person sees a card and confirms or cancels it.',
    inputSchema: {
      type: 'object',
      properties: {
        target: TARGET,
        text: { type: 'string', description: 'The exact text to send, in the words the person asked for.' },
        kind: { type: 'string', enum: ['note', 'question', 'decision'], description: 'Only for rooms; note by default.' },
        mention: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Only for rooms: the agents of this room the message is for (session ids from parley_overview, or exact names). They are mentioned with @ and get it addressed to them; the rest of the room still sees it. Without it the message is a task for everyone in the room.',
        },
      },
      required: ['target', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'end_conversation',
    description: 'The person asked to start over: the conversation is forgotten after this reply.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

export interface AssistantServerOptions {
  /** База маршрута хоста (`PARLEY_ASSISTANT_URL`), без завершающего `/`. */
  url: string;
  token: string;
  /** Для тестов. */
  fetch?: typeof fetch;
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: true };

const failure = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

export function createAssistantServer(options: AssistantServerOptions): Server {
  const call = options.fetch ?? fetch;
  const server = new Server({ name: ASSISTANT_MCP_NAME, version: '0.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ASSISTANT_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<ToolResult> => {
    const name = request.params.name;
    if (!ASSISTANT_TOOLS.some((tool) => tool.name === name)) return failure(`unknown tool ${name}`);
    try {
      const response = await call(`${options.url}/${name}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${options.token}` },
        body: JSON.stringify(request.params.arguments ?? {}),
      });
      const body = (await response.json().catch(() => ({}))) as { text?: unknown; error?: unknown };
      if (response.ok && typeof body.text === 'string') return { content: [{ type: 'text', text: body.text }] };
      return failure(typeof body.error === 'string' ? body.error : `Parley answered ${response.status}`);
    } catch (error) {
      return failure(`Parley is not reachable: ${(error as Error).message}`);
    }
  });
  return server;
}
