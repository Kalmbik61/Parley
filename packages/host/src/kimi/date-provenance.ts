import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { KimiReplayChunk } from './sessions.js';

const MAX_WIRE_BYTES = 8 * 1024 * 1024;
const MAX_WIRE_RECORDS = 8192;

interface Binding {
  home: string;
  cwd: string;
  sessionId: string;
}

function workspaceKey(cwd: string): string {
  // Stock 2.7.3's implicit workspace key. Never search other session directories.
  const normalized = path.resolve(cwd).replaceAll('\\', '/').replace(/\/+$/, '');
  const part = normalized.split('/').at(-1) ?? '';
  const slug = part.toLowerCase().replaceAll(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/^-+|-+$/g, '');
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 12);
  return `wd_${slug === '' || slug === '.' || slug === '..' ? 'workspace' : slug}_${hash}`;
}

async function readBoundWire({ home, cwd, sessionId }: Binding): Promise<string | undefined> {
  if (!path.isAbsolute(home) || !path.isAbsolute(cwd) || !/^session_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(sessionId)) return;
  try {
    if (!(await lstat(home)).isDirectory() || await realpath(home) !== home) return;
    let dir = home;
    for (const part of ['sessions', workspaceKey(cwd), sessionId, 'agents', 'main']) {
      dir = path.join(dir, part);
      if (!(await lstat(dir)).isDirectory()) return;
    }
    const file = path.join(dir, 'wire.jsonl');
    const expected = await lstat(file);
    if (!expected.isFile() || expected.nlink !== 1 || expected.size > MAX_WIRE_BYTES) return;
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size > MAX_WIRE_BYTES ||
          before.dev !== expected.dev || before.ino !== expected.ino || await realpath(file) !== file) return;
      const data = Buffer.alloc(before.size);
      for (let offset = 0; offset < data.length;) {
        const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
        if (bytesRead === 0) return;
        offset += bytesRead;
      }
      const after = await handle.stat();
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) return;
      return new TextDecoder('utf-8', { fatal: true }).decode(data);
    } finally {
      await handle.close();
    }
  } catch {
    // The wire is corroborating evidence only. Unavailable or unsafe evidence is not a new launch failure.
    return undefined;
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Keep ACP as the history source. The main wire supplies only positively aligned user-part provenance. */
export async function withoutKimiDateContext(binding: Binding, chunks: readonly KimiReplayChunk[]): Promise<readonly KimiReplayChunk[]> {
  const user = chunks.flatMap((chunk, index) => chunk.author === 'user' ? [{ chunk, index }] : []);
  if (user.length < 2 || user.some(({ chunk }) => chunk.messageId !== undefined)) return chunks;
  const wire = await readBoundWire(binding);
  if (wire === undefined || !wire.endsWith('\n')) return chunks;
  const lines = wire.slice(0, -1).split('\n');
  if (lines.length > MAX_WIRE_RECORDS) return chunks;
  const removed = new Set<number>();
  let cursor = 0;
  let previousHuman = false;
  try {
    for (const [line, value] of lines.entries()) {
      const row = object(JSON.parse(value));
      if (typeof row?.['type'] !== 'string') return chunks;
      const type = row['type'];
      if (line === 0) {
        if (type !== 'metadata' || row['protocol_version'] !== '1.5' || row['min_protocol_version'] !== '1.5') return chunks;
        continue;
      }
      if (type === 'metadata' || type.startsWith('session.fork') || type === 'turn.steer') return chunks;
      if (!type.startsWith('context.')) continue;
      if (type === 'context.append_loop_event') {
        if (row['agentId'] !== 'main') return chunks;
        previousHuman = false;
        continue;
      }
      // Undo, clear, compaction and unknown context operations need a different alignment model.
      if (type !== 'context.append_message' || row['agentId'] !== 'main') return chunks;
      const message = object(row['message']);
      if (typeof message?.['role'] !== 'string' || !Array.isArray(message['content'])) return chunks;
      if (message['role'] !== 'user') {
        previousHuman = false;
        continue;
      }
      const origin = object(message['origin']);
      const date = origin?.['kind'] === 'injection' && origin['variant'] === 'date_change' && object(origin['disclosure'])?.['kind'] === 'date';
      const human = origin?.['kind'] === 'user';
      const parts = message['content'] as unknown[];
      if (date && parts.length !== 1) return chunks;
      let hasText = false;
      for (const value of parts) {
        const part = object(value);
        if (typeof part?.['type'] !== 'string') return chunks;
        if (part['type'] !== 'text') continue;
        const text = part['text'];
        if (typeof text !== 'string') return chunks;
        if (text === '') continue;
        const at = user[cursor++];
        if (at === undefined || at.chunk.text !== text) return chunks;
        hasText = true;
        if (date) {
          if (!previousHuman || chunks[at.index - 1]?.author !== 'user') return chunks;
          removed.add(at.index);
        }
      }
      previousHuman = human && hasText;
    }
  } catch {
    return chunks;
  }
  return cursor === user.length && removed.size > 0 ? chunks.filter((_, index) => !removed.has(index)) : chunks;
}
