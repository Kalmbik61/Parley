import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { workspaceKey } from './date-provenance.js';

const READ_BYTES = 256 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const TEXT_LIMIT = 64 * 1024;
export const KIMI_SESSION_ID = /^session_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export type WireRow = Record<string, unknown> & { type: string };
type Limitation = 'replaced' | 'truncated' | 'invalid' | 'oversized' | 'unsupported';
type WireRead = { rows: WireRow[]; limitation?: Limitation; more?: true };
type Binding = { home: string; cwd: string; sessionId: string };

export const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export async function createKimiWire({ home, cwd, sessionId }: Binding) {
  if (!path.isAbsolute(home) || !path.isAbsolute(cwd) || !KIMI_SESSION_ID.test(sessionId)) throw new Error('Invalid Kimi wire binding');
  const canonical = await realpath(home);
  const file = path.join(canonical, 'sessions', workspaceKey(cwd), sessionId, 'agents', 'main', 'wire.jsonl');
  let offset = 0;
  let identity: { dev: number; ino: number } | undefined;
  let anchor: Buffer = Buffer.alloc(0);
  let pending: Buffer = Buffer.alloc(0);
  let skipping = false;
  let header = false;
  let stopped: Limitation | undefined;
  const decode = new TextDecoder('utf-8', { fatal: true });

  return {
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
        if (stat.size === offset) return result;
        const data = Buffer.alloc(Math.min(READ_BYTES, stat.size - offset));
        const { bytesRead } = await fd.read(data, 0, data.length, offset);
        if (bytesRead === 0) return result;
        const chunk = data.subarray(0, bytesRead);
        offset += bytesRead;
        if (offset < stat.size) result.more = true;
        anchor = Buffer.concat([anchor, chunk]).subarray(-64);
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
        pending = skipping ? Buffer.alloc(0) : rest;
        return result;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT' ? result : stop('invalid');
      } finally {
        await fd?.close();
      }
    },
  };
}

export type KimiWireEvent =
  | { kind: 'prompt' | 'text'; id: string; text: string; at: number }
  | { kind: 'tool'; id: string; name: string; input: unknown; at: number }
  | { kind: 'result'; id: string; output: unknown; isError: boolean; at: number }
  | { kind: 'request'; id: string; interaction: 'approval' | 'question'; request: Record<string, unknown>; at: number }
  | { kind: 'resolved'; id: string; response: unknown; at: number }
  | { kind: 'end'; reason: string; at: number }
  | { kind: 'working' | 'compact-start' | 'compact' | 'undo' | 'clear' | 'unsupported'; at: number };

const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512;
const content = (value: unknown): string => typeof value === 'string' ? value.slice(0, TEXT_LIMIT) : '';

/** The wire and the hooks overlap. Only the wire projects content and request identity. */
export function projectKimiWire(row: WireRow): KimiWireEvent | undefined {
  if (row.agentId !== 'main') return undefined;
  const at = typeof row.time === 'number' && Number.isFinite(row.time) && Math.abs(row.time) < 8.64e15 ? row.time : 0;
  if (row.type === 'context.append_message') {
    const message = record(row.message);
    if (message?.role !== 'user') return undefined;
    const origin = record(message.origin)?.kind;
    if (origin === 'injection') return undefined;
    if (origin !== 'user') return { kind: 'unsupported', at };
    if (!identifier(message.id) || !Array.isArray(message.content)) return { kind: 'unsupported', at };
    const text = message.content.map(record).filter(part => part?.type === 'text' && record(part.meta)?.source !== 'user prompt submit hook')
      .map(part => content(part?.text)).join('\n').slice(0, TEXT_LIMIT);
    return text ? { kind: 'prompt', id: message.id, text, at } : { kind: 'unsupported', at };
  }
  if (row.type === 'context.append_loop_event') {
    const event = record(row.event);
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
  if (row.type === 'context.undo') return { kind: 'undo', at };
  if (row.type === 'context.clear') return { kind: 'clear', at };
  if (row.type === 'turn.steer' || (row.type.startsWith('context.') && row.type !== 'context.apply_compaction') || row.type === 'agent.switched' || row.type === 'forked') return { kind: 'unsupported', at };
  return undefined;
}
