/**
 * Режим помощника `parley-mcp` (спека 2026-10-14, 7.1): десять инструментов, каждый — POST в маршрут хоста
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
    name: 'propose_room',
    description:
      'Prepare a new room (group chat of agents) in one work. The work is a work:… id from parley_overview or its exact title; members are session ids or names of sessions of that work; task is the first message sent to the room. Nothing is created: the person sees a card and confirms or cancels it.',
    inputSchema: {
      type: 'object',
      properties: {
        work: { type: 'string', description: 'A work:… id from parley_overview, or the exact title of the work.' },
        title: { type: 'string', description: 'The title of the new room.' },
        members: { type: 'array', items: { type: 'string' }, description: 'Session ids or exact names of sessions of this work.' },
        lead: { type: 'string', description: 'Optional: the member who leads the room (session id or exact name).' },
        task: { type: 'string', description: 'Optional: the first message sent to the room once it exists.' },
      },
      required: ['work', 'title', 'members'],
      additionalProperties: false,
    },
  },
  {
    name: 'propose_decision',
    description:
      'Prepare the answer to a request that a session is waiting on the person for: a permission, a question or a plan. Only for a session that waits for the person right now. Set always only when the card itself offered "don\'t ask again". For a plan both choices approve it: auto-accept applies edits freely, manual asks for each edit as a separate card. Nothing is decided: the person sees a card and confirms or cancels it.',
    inputSchema: {
      type: 'object',
      properties: {
        target: TARGET,
        card: { type: 'string', description: 'Only when the session has several pending requests of this kind: the card id from the tool reply or parley_overview.' },
        decision: {
          oneOf: [
            {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['permission'] },
                behavior: { type: 'string', enum: ['allow', 'deny'] },
                always: { type: 'boolean', enum: [true] },
              },
              required: ['kind', 'behavior'],
              additionalProperties: false,
            },
            {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['question'] },
                answers: { type: 'object', additionalProperties: { type: 'string' }, description: 'The answers as plain strings. A key is the question number ("1", "2") or its exact text; a value is one of its option labels or free text. parley_detail lists the options.' },
              },
              required: ['kind', 'answers'],
              additionalProperties: false,
            },
            {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['plan'] },
                choice: { type: 'string', enum: ['auto-accept', 'manual'] },
              },
              required: ['kind', 'choice'],
              additionalProperties: false,
            },
          ],
        },
      },
      required: ['target', 'decision'],
      additionalProperties: false,
    },
  },
  {
    name: 'propose_room_decision',
    description:
      'Prepare the decision or the completion that the lead of a room waits for from the person: accept it, or return it for more work. note is a note to the lead when returning. Nothing is decided: the person sees a card and confirms or cancels it.',
    inputSchema: {
      type: 'object',
      properties: {
        target: TARGET,
        choice: { type: 'string', enum: ['accept', 'return'] },
        note: { type: 'string', description: 'Only with return: a note to the lead of the room.' },
      },
      required: ['target', 'choice'],
      additionalProperties: false,
    },
  },
  {
    name: 'schedule_check',
    description:
      'Ask Parley to wake you later to check something; say the time back to the person. This is not a card. Give in_minutes (from now) or at (a local time), and every_minutes to repeat. what is what to check and report.',
    inputSchema: {
      type: 'object',
      properties: {
        in_minutes: { type: 'number', description: 'Wake up after this many minutes.' },
        at: { type: 'string', description: 'Wake up at this local time, for example 15:30.' },
        every_minutes: { type: 'number', description: 'Repeat every this many minutes.' },
        what: { type: 'string', description: 'What to check and report back, in the words the person used.' },
      },
      required: ['what'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_reminders',
    description: 'The checks scheduled with schedule_check that have not fired yet, with their ids and times.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'cancel_reminder',
    description: 'Cancel one scheduled check by its id from list_reminders; "*" cancels all of them.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'A reminder id, or * for all.' } }, required: ['id'], additionalProperties: false },
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
