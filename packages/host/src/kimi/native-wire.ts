import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { workspaceKey } from './date-provenance.js';

const READ_BYTES = 256 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const TEXT_LIMIT = 64 * 1024;
const SUBAGENT_ID = /^(?!main$)[A-Za-z0-9_-]{1,80}$/;
export const KIMI_SESSION_ID = /^session_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export type WireRow = Record<string, unknown> & { type: string };
type Limitation = 'replaced' | 'truncated' | 'invalid' | 'oversized' | 'unsupported';
type WireRead = { rows: WireRow[]; limitation?: Limitation; more?: true };
type Binding = { home: string; cwd: string; sessionId: string };

export const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const emptyStartupRows = new Set(['environment.set_binding', 'permission.set_mode', 'changeNotifier.snapshot', 'profile.bind', 'mcp.tools_discovered']);

/** Verify the entire wire before startup may rotate this empty conversation. */
export async function proveKimiEmptyStartup({ home, cwd, sessionId }: Binding, expected: readonly string[]): Promise<'waiting' | 'unsafe' | 'ready'> {
  if (!path.isAbsolute(home) || !path.isAbsolute(cwd) || !KIMI_SESSION_ID.test(sessionId)) return 'unsafe';
  let fd;
  try {
    const canonical = await realpath(home);
    const file = path.join(canonical, 'sessions', workspaceKey(cwd), sessionId, 'agents', 'main', 'wire.jsonl');
    if (await realpath(file) !== file) return 'unsafe';
    fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await fd.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_LINE_BYTES) return 'unsafe';
    if (before.size === 0) return 'waiting';
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await fd.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) return 'waiting';
      offset += bytesRead;
    }
    const after = await fd.stat();
    const name = await lstat(file);
    if (!name.isFile() || name.dev !== before.dev || name.ino !== before.ino || await realpath(file) !== file) return 'unsafe';
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || name.size !== after.size || name.mtimeMs !== after.mtimeMs) return 'waiting';
    if (bytes.at(-1) !== 10) return 'waiting';
    const [head, ...lines] = new TextDecoder('utf-8', { fatal: true }).decode(bytes).slice(0, -1).split('\n');
    const header = record(JSON.parse(head!));
    if (header?.type !== 'metadata' || header.protocol_version !== '1.5' || header.min_protocol_version !== '1.5') return 'unsafe';
    let latest: Record<string, unknown> | undefined;
    for (const line of lines) {
      const row = record(JSON.parse(line));
      // Other MCP servers can fail or recover while Kimi discovers Parley's tools.
      if ((row?.type === 'mcp.server_failed' || row?.type === 'mcp.server_failure_resolved') &&
          row.agentId === 'main' && typeof row.serverName === 'string' && row.serverName.trim() && row.serverName !== 'parley') continue;
      if (typeof row?.type !== 'string' || !emptyStartupRows.has(row.type)) return 'unsafe';
      if (row.type === 'mcp.tools_discovered' && row.agentId === 'main' && row.serverName === 'parley') latest = row;
    }
    if (!latest || !expected.includes('get_map')) return 'waiting';
    const same = (names: unknown) => Array.isArray(names) && names.length === expected.length &&
      new Set(names).size === expected.length && expected.every(tool => names.includes(tool));
    const names = Array.isArray(latest.tools) ? latest.tools.map(tool => record(tool)?.name) : null;
    return same(names) && same(latest.enabledNames) && latest.collisions === undefined ? 'ready' : 'unsafe';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'waiting' : 'unsafe';
  } finally {
    await fd?.close();
  }
}

export async function createKimiWire({ home, cwd, sessionId }: Binding, { snapshot = false } = {}) {
  if (!path.isAbsolute(home) || !path.isAbsolute(cwd) || !KIMI_SESSION_ID.test(sessionId)) throw new Error('Invalid Kimi wire binding');
  const canonical = await realpath(home);
  const dir = path.join(canonical, 'sessions', workspaceKey(cwd), sessionId, 'agents');
  const tail = (id: string) => createWireTail(path.join(dir, id, 'wire.jsonl'), snapshot);
  const main = tail('main');
  const children: { id: string; tail: ReturnType<typeof tail> }[] = [];
  const parentByChild = new Map<string, string>();
  let childIndex = 0;
  let mainDone = false;

  const acceptsLifecycle = (owner: string, row: WireRow): boolean => {
    const event = projectKimiSubagent(row, 0);
    if (event === undefined) return false;
    const parent = parentByChild.get(event.id);
    if (event.phase !== 'spawned') return (parent ?? 'main') === owner;
    if ((parent !== undefined && parent !== owner) ||
        (row.parentAgentId !== undefined && row.parentAgentId !== owner) ||
        (row.callerAgentId !== undefined && row.callerAgentId !== owner)) return false;
    if (parent === undefined) {
      parentByChild.set(event.id, owner);
      children.push({ id: event.id, tail: tail(event.id) });
    }
    return true;
  };

  return {
    async read(): Promise<WireRead> {
      const result: WireRead = mainDone ? { rows: [] } : await main.read();
      mainDone = snapshot && result.more !== true;
      if (main.stopped) return result;
      result.rows = result.rows.filter(row => !row.type.startsWith('subagent.') || acceptsLifecycle('main', row));
      // Kimi writes nested lifecycle records to the requester's own wire. Follow
      // only positively discovered agents in this bound session, never scan neighbors
      // or pass the child's prompts, tools, or turn state to the parent feed.
      const child = children[childIndex];
      if (child !== undefined) {
        const next = await child.tail.read();
        for (const row of next.rows) if (acceptsLifecycle(child.id, row)) result.rows.push(row);
        if (next.limitation !== undefined) result.limitation ??= next.limitation;
        if (!snapshot || !next.more) childIndex++;
        if (!snapshot && childIndex >= children.length) childIndex = 0;
      }
      if (snapshot && childIndex < children.length) result.more = true;
      return result;
    },
  };
}

function createWireTail(file: string, snapshot: boolean) {
  let offset = 0;
  let horizon: number | undefined;
  let identity: { dev: number; ino: number } | undefined;
  let anchor: Buffer = Buffer.alloc(0);
  let pending: Buffer = Buffer.alloc(0);
  let skipping = false;
  let header = false;
  let stopped: Limitation | undefined;
  const decode = new TextDecoder('utf-8', { fatal: true });

  return {
    get stopped(): boolean { return stopped !== undefined; },
    async read(): Promise<WireRead> {
      if (stopped !== undefined) return { rows: [], limitation: stopped };
      const result: WireRead = { rows: [] };
      const stop = (limitation: Limitation): WireRead => ({ rows: [], limitation: stopped = limitation });
      let fd;
      try {
        if (await realpath(file) !== file) return stop('invalid');
        fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const stat = await fd.stat();
        if (!stat.isFile() || stat.nlink !== 1 || await realpath(file) !== file) return stop('invalid');
        if (identity !== undefined && (stat.dev !== identity.dev || stat.ino !== identity.ino)) return stop('replaced');
        identity = { dev: stat.dev, ino: stat.ino };
        if (stat.size < offset) return stop('truncated');
        if (anchor.length !== 0) {
          const previous = Buffer.alloc(anchor.length);
          const { bytesRead } = await fd.read(previous, 0, previous.length, offset - previous.length);
          if (bytesRead !== previous.length || !previous.equals(anchor)) return stop('replaced');
        }
        // A cold read uses a fixed byte horizon per file. It can reach the end
        // of any existing wire without waiting indefinitely on an active writer.
        if (snapshot) horizon ??= stat.size;
        const end = horizon ?? stat.size;
        if (stat.size < end) return stop('truncated');
        if (end === offset) return result;
        const data = Buffer.alloc(Math.min(READ_BYTES, end - offset));
        const { bytesRead } = await fd.read(data, 0, data.length, offset);
        if (bytesRead === 0) return stop('truncated');
        const chunk = data.subarray(0, bytesRead);
        offset += bytesRead;
        if (offset < end) result.more = true;
        anchor = Buffer.from(chunk.length >= 64 ? chunk.subarray(-64) : Buffer.concat([anchor, chunk]).subarray(-64));
        const merged = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        let start = 0;
        for (;;) {
          const end = merged.indexOf(10, start);
          if (end === -1) break;
          if (!skipping) {
            if (end - start > MAX_LINE_BYTES) {
              if (!header) return stop('unsupported');
              result.limitation = 'oversized';
            } else {
              let row: ReturnType<typeof record>;
              try { row = record(JSON.parse(decode.decode(merged.subarray(start, end)))); } catch { /* Report malformed evidence. */ }
              if (!header) {
                if (row?.type !== 'metadata' || row.protocol_version !== '1.5' || row.min_protocol_version !== '1.5') return stop('unsupported');
                header = true;
              } else if (typeof row?.type === 'string') result.rows.push(row as WireRow);
              else result.limitation = 'invalid';
            }
          }
          skipping = false;
          start = end + 1;
        }
        const rest = merged.subarray(start);
        if (rest.length > MAX_LINE_BYTES) {
          if (!header) return stop('unsupported');
          skipping = true;
          result.limitation = 'oversized';
        }
        pending = skipping || rest.length === 0 ? Buffer.alloc(0) : rest;
        return result;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT' ? result : stop('invalid');
      } finally {
        await fd?.close();
      }
    },
  };
}

type KimiSubagentEvent = { kind: 'subagent'; id: string; at: number } & (
  | { phase: 'spawned'; name: string | null; description: string | null; model: string | null; background: boolean; toolUseId: string | null }
  | { phase: 'started' }
  | { phase: 'completed' | 'failed' | 'cancelled'; result?: string }
);

export type KimiWireEvent =
  | KimiSubagentEvent
  | { kind: 'prompt' | 'steer' | 'text'; id: string; text: string; at: number }
  | { kind: 'tool'; id: string; name: string; input: unknown; at: number }
  | { kind: 'result'; id: string; output: unknown; isError: boolean; at: number }
  | { kind: 'request'; id: string; interaction: 'approval' | 'question'; request: Record<string, unknown>; at: number }
  | { kind: 'resolved'; id: string; response: unknown; at: number }
  | { kind: 'end'; reason: string; at: number }
  | { kind: 'working' | 'compact-start' | 'compact' | 'compact-cancel' | 'undo' | 'clear' | 'unsupported'; at: number };

const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512;
const content = (value: unknown): string => typeof value === 'string' ? value.slice(0, TEXT_LIMIT) : '';

const userPromptId = (value: unknown): value is string => identifier(value) &&
  (/^msg_[\w-]+$/.test(value) || /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value));
const userText = (parts: unknown): string => Array.isArray(parts)
  ? parts.map(record).filter(part => part?.type === 'text' && record(part.meta)?.source !== 'user prompt submit hook')
    .map(part => content(part?.text)).join('\n').slice(0, TEXT_LIMIT)
  : '';

function projectKimiSubagent(row: WireRow, at: number): KimiSubagentEvent | undefined {
  const id = row.subagentId;
  if (typeof id !== 'string' || !SUBAGENT_ID.test(id)) return;
  const base = { kind: 'subagent' as const, id, at };
  switch (row.type) {
    case 'subagent.spawned':
      return { ...base, phase: 'spawned', name: content(row.subagentName) || null, description: content(row.description) || null,
        model: content(row.model) || null, background: row.runInBackground === true, toolUseId: identifier(row.parentToolCallId) ? row.parentToolCallId : null };
    case 'subagent.started':
      return { ...base, phase: 'started' };
    case 'subagent.completed':
      return { ...base, phase: 'completed', ...(typeof row.resultSummary === 'string' ? { result: content(row.resultSummary) } : {}) };
    case 'subagent.failed':
      return { ...base, phase: 'failed', ...(typeof row.error === 'string' ? { result: content(row.error) } : {}) };
    case 'subagent.cancelled':
      return { ...base, phase: 'cancelled' };
  }
}

/** The wire and the hooks overlap. Only the wire projects content and request identity. */
export function projectKimiWire(row: WireRow): KimiWireEvent | undefined {
  const at = typeof row.time === 'number' && Number.isFinite(row.time) && Math.abs(row.time) < 8.64e15 ? row.time : 0;
  if (row.type.startsWith('subagent.')) return projectKimiSubagent(row, at);
  if (row.agentId !== 'main') return undefined;
  if (row.type === 'prompt.steered') {
    // The same event also carries task-completion notifications, not human input.
    const id = row.messageId;
    if (!userPromptId(id) || !identifier(row.activePromptId) || !Array.isArray(row.promptIds) || !row.promptIds.includes(id)) return;
    const text = userText(row.content);
    if (text) return { kind: 'steer', id, text, at };
    return;
  }
  if (row.type === 'turn.steer') {
    const id = row.messageId;
    if (record(row.origin)?.kind !== 'user' || !userPromptId(id)) return;
    const text = userText(row.input);
    if (text) return { kind: 'steer', id, text, at };
    return;
  }
  if (row.type === 'context.append_message') {
    const message = record(row.message);
    if (message?.role !== 'user') return undefined;
    const origin = record(message.origin);
    if (origin?.kind === 'injection') return undefined;
    if (origin?.kind !== 'user' || !identifier(message.id)) return { kind: 'unsupported', at };
    const text = userText(message.content);
    return text ? { kind: origin.inTurn === true ? 'steer' : 'prompt', id: message.id, text, at } : { kind: 'unsupported', at };
  }
  if (row.type === 'context.append_loop_event') {
    const event = record(row.event);
    // The first model step is recorded before reasoning or reply parts are persisted.
    if (event?.type === 'step.begin') return { kind: 'working', at };
    const part = record(event?.part);
    if (event?.type === 'content.part' && identifier(event.uuid) && part?.type === 'text' && typeof part.text === 'string') {
      return { kind: 'text', id: event.uuid, text: content(part.text), at };
    }
    if (event?.type === 'tool.call' && identifier(event.toolCallId) && identifier(event.name)) {
      return { kind: 'tool', id: event.toolCallId, name: event.name, input: event.args, at };
    }
    if (event?.type === 'tool.result' && identifier(event.toolCallId)) {
      const result = record(event.result);
      return { kind: 'result', id: event.toolCallId, output: result?.output, isError: result?.isError === true, at };
    }
    return undefined;
  }
  if (row.type === 'interaction.request' && identifier(row.id) && (row.kind === 'approval' || row.kind === 'question')) {
    const request = record(row.request);
    if (request !== undefined) return { kind: 'request', id: row.id, interaction: row.kind, request, at };
  }
  if (row.type === 'interaction.resolved' && identifier(row.id)) return { kind: 'resolved', id: row.id, response: row.response, at };
  if (row.type === 'turn.ended') return { kind: 'end', reason: content(row.reason), at };
  if (row.type === 'full_compaction.begin') return { kind: 'compact-start', at };
  if (row.type === 'full_compaction.complete') return { kind: 'compact', at };
  if (row.type === 'full_compaction.cancel') return { kind: 'compact-cancel', at };
  if (row.type === 'context.undo') return { kind: 'undo', at };
  if (row.type === 'context.clear') return { kind: 'clear', at };
  if ((row.type.startsWith('context.') && row.type !== 'context.apply_compaction') || row.type === 'agent.switched' || row.type === 'forked') return { kind: 'unsupported', at };
  return undefined;
}
