import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { AgentChannel } from '../work/mcp-config.js';
import { queuedNotes } from './session-tools.js';

/** Спека роя v1, 4: в этом файле только константы инструментов и вызов канала хоста; правила — на хосте. */
const HINTS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

export const CREATE_SWARM_TOOL: Tool = {
  name: 'create_swarm',
  description: 'Start a research swarm: a queen session that splits a read-only task between drones and verifiers. Only for a big research task that does not fit one context; a narrow task is faster and cheaper with one agent. The result goes to you. Take provider, models and effort from get_map {field: "providers"}. Method: the research-swarm skill.',
  annotations: HINTS,
  inputSchema: {
    type: 'object',
    properties: {
      tag: { type: 'string', minLength: 1, maxLength: 24, description: 'Research, Audit, Debug or your own short text.' },
      objective: { type: 'string', minLength: 1, maxLength: 4096 },
      provider: { type: 'string', minLength: 1 },
      role: { type: 'string', description: 'Queen role id from list_roles.' },
      model: { type: ['string', 'null'] },
      effort: { type: ['string', 'null'] },
    },
    required: ['tag', 'objective', 'provider'],
    additionalProperties: false,
  },
};

export const SWARM_ADD_TOOL: Tool = {
  name: 'swarm_add',
  description: 'Queen only: add a drone (reads a slice) or a verifier (rechecks claims) to your swarm. Members are read-only, hand in with report done and are closed automatically.',
  annotations: HINTS,
  inputSchema: {
    type: 'object',
    properties: {
      role: { type: 'string', enum: ['drone', 'verifier'] },
      task: { type: 'string', minLength: 1 },
      provider: { type: 'string', minLength: 1 },
      label: { type: 'string', minLength: 1 },
      agentRole: { type: 'string', description: 'Role id from list_roles; default researcher (drone) or verifier.' },
      model: { type: ['string', 'null'] },
      effort: { type: ['string', 'null'] },
    },
    required: ['role', 'task', 'provider'],
    additionalProperties: false,
  },
};

export const SWARM_UNAVAILABLE = 'Swarms require an identified Parley session with a host connection. Restart this session from an updated Parley app.';
const CHECK_MAP = 'Check get_map before retrying: the host may already have created the session.';
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const error = (text: string): CallToolResult => ({ content: [{ type: 'text', text }], isError: true });

/** `create_swarm` и `swarm_add` ходят в один маршрут хоста; операцию задаёт `op`, рой и вызывающего хост берёт из токена. */
async function swarmCall(
  agent: AgentChannel,
  op: 'create' | 'add',
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<CallToolResult> {
  let response: Response;
  try {
    response = await fetch(new URL('/agent/swarms', agent.url), {
      method: 'POST',
      headers: { Authorization: `Bearer ${agent.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...args, op }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
      redirect: 'error',
    });
  } catch {
    return error(`Parley's host did not return a creation result. ${CHECK_MAP}`);
  }
  if (response.status === 401) return error("Parley does not recognise this session's token. Restart this session from Parley.");
  if (response.status === 404) return error("Parley's host does not support swarms. Update Parley and restart this session.");
  if (response.status !== 200) return error(`Parley's host refused the request (HTTP ${response.status}). ${CHECK_MAP}`);
  let body: unknown;
  try { body = await response.json(); } catch { return error(`Parley's host sent an unreadable answer. ${CHECK_MAP}`); }
  if (isRecord(body) && body.ok === true && isRecord(body.result)) {
    const { result } = body;
    const known = op === 'create'
      ? typeof result.swarmId === 'string' && typeof result.queenSessionId === 'string'
      : typeof result.sessionId === 'string' && typeof result.member === 'string';
    // Сессия роя (королева или участник) встала в очередь машины (спека ёмкости 4.2): она заведена, запуск ждёт слота, как у `create_session`.
    if (known) return { content: [{ type: 'text', text: JSON.stringify(result) }, ...queuedNotes(result)] };
  }
  if (isRecord(body) && body.ok === false && isRecord(body.error) && typeof body.error.code === 'string' && typeof body.error.message === 'string') {
    return error(`${body.error.code}: ${body.error.message}`);
  }
  return error(`Parley's host sent an unreadable answer. ${CHECK_MAP}`);
}

export const createSwarm = (agent: AgentChannel, args: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult> =>
  swarmCall(agent, 'create', args, signal);

export const swarmAdd = (agent: AgentChannel, args: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult> =>
  swarmCall(agent, 'add', args, signal);
