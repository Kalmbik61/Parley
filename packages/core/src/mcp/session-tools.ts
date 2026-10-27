import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { AgentChannel } from '../work/mcp-config.js';

export const CREATE_SESSION_TOOL: Tool = {
  name: 'create_session',
  description: 'Creates and starts an independent session in this same workspace. Take the provider, its models, effort levels and limits from get_map {field: "providers"}; an account of the same CLI (for example custom-claude-2) is a separate subscription with its own limits. It is a peer, with no parent and no room membership. Give it a task; a room lead can later invite it with add_to_room. Workspace creation and launch limits apply.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  inputSchema: {
    type: 'object',
    properties: {
      provider: { type: 'string', minLength: 1, description: 'Provider id from get_map {field: "providers"}.' },
      label: { type: 'string', minLength: 1, description: 'Short session name.' },
      task: { type: 'string', minLength: 1, description: 'The task for the new session.' },
      role: { type: 'string', description: 'Source-qualified role id from list_roles. A native role must match the provider; Claude roles also fit GLM.' },
      agent: { type: 'string', description: 'Legacy native Claude role name. Do not combine with role.' },
      worktree: { type: 'boolean', description: 'Create an isolated git worktree from the project base. Requires a git project.' },
      model: { type: ['string', 'null'], description: 'Model id from the selected provider in get_map {field: "providers"}. Omit for the role/provider default; null clears the role default.' },
      effort: { type: ['string', 'null'], description: 'Reasoning effort from the selected model in get_map {field: "providers"}. Omit for the role/provider default; null clears the role default.' },
    },
    required: ['provider', 'label', 'task'],
    additionalProperties: false,
  },
};

export const SESSION_CREATION_UNAVAILABLE = 'Creating sessions requires an identified Parley session with a host connection. Restart this session from an updated Parley app.';
const CHECK_MAP = 'Check get_map before retrying: the host may already have created the session.';
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const error = (text: string): CallToolResult => ({ content: [{ type: 'text', text }], isError: true });

const FOLDER_TRUST_HELD = 'The session waits for the human to trust the folder; it starts by itself after that.';

/** The host derives the workspace from the token; the model cannot select a different scope. */
export async function createSession(agent: AgentChannel, args: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult> {
  let response: Response;
  try {
    response = await fetch(new URL('/agent/sessions', agent.url), {
      method: 'POST',
      headers: { Authorization: `Bearer ${agent.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
      redirect: 'error',
    });
  } catch {
    return error(`Parley's host did not return a creation result. ${CHECK_MAP}`);
  }
  if (response.status === 401) return error("Parley does not recognise this session's token. Restart this session from Parley.");
  if (response.status === 404) return error("Parley's host does not support create_session. Update Parley and restart this session.");
  if (response.status !== 200) return error(`Parley's host refused the request (HTTP ${response.status}). ${CHECK_MAP}`);
  let body: unknown;
  try { body = await response.json(); } catch { return error(`Parley's host sent an unreadable answer. ${CHECK_MAP}`); }
  if (isRecord(body) && body.ok === true && isRecord(body.result) && typeof body.result.sessionId === 'string' && body.result.sessionId && typeof body.result.provider === 'string' && body.result.provider) {
    // Запуск Codex удержан до согласия человека на папку (спека 2026-10-21, 4.2): ответ пришёл сразу, сессия стартует сама.
    if (body.result.held === 'folder-trust') {
      return { content: [{ type: 'text', text: JSON.stringify(body.result) }, { type: 'text', text: FOLDER_TRUST_HELD }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(body.result) }] };
  }
  if (isRecord(body) && body.ok === false && isRecord(body.error) && typeof body.error.code === 'string' && typeof body.error.message === 'string') {
    return error(`${body.error.code}: ${body.error.message}`);
  }
  return error(`Parley's host sent an unreadable answer. ${CHECK_MAP}`);
}
