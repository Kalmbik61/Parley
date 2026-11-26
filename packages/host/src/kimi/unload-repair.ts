import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { workspaceKey } from './date-provenance.js';
import { KIMI_SESSION_ID, record, type WireRow } from './native-wire.js';

export type KimiUnloadRepairBinding = { home: string; cwd: string; sessionId: string };

/**
 * `repaired` — the announcements naming the tool are gone, the original bytes are in `backup`;
 * `clean` — no post-compaction announcement names the tool (nothing to do, idempotent);
 * `refused` — the wire was not touched: a live process, a concurrent change, or an unsafe file.
 */
export type KimiUnloadRepair =
  | { status: 'repaired'; backup: string; removed: number; poisoned: number }
  | { status: 'clean'; poisoned: number }
  | { status: 'refused'; reason: 'live' | 'changed' | 'invalid' };

type Announcement = { line: number; removed: string[] };

/**
 * Poisoned announcements are tool_lifecycle injections with removals after the last
 * context.apply_compaction: only those survive into the sent history (audit 2026-11-26).
 * Added-only announcements are harmless and stay.
 */
function poisonedAnnouncements(rows: readonly WireRow[]): Announcement[] {
  let compaction = -1;
  rows.forEach((row, index) => { if (row.type === 'context.apply_compaction') compaction = index; });
  const found: Announcement[] = [];
  rows.forEach((row, index) => {
    if (index <= compaction || row.type !== 'context.append_message' || row.agentId !== 'main') return;
    const parts = record(row.message)?.content;
    if (!Array.isArray(parts)) return;
    for (const part of parts) {
      const meta = record(record(part)?.meta);
      if (meta?.kind !== 'tool_lifecycle' || !Array.isArray(meta.removed)) continue;
      const removed = meta.removed.filter((name): name is string => typeof name === 'string');
      if (removed.length > 0) {
        found.push({ line: index, removed });
        break;
      }
    }
  });
  return found;
}

/**
 * Remove the poisoned announcements naming `tool` from the main wire — only while the session
 * process is stopped (`live` is re-checked right before the write). The original bytes are backed
 * up beside the wire; every other line is preserved byte-for-byte; the rewrite is atomic and
 * refuses a file that changed between the read and the write.
 */
export async function repairKimiUnloadPoison(
  { home, cwd, sessionId }: KimiUnloadRepairBinding,
  tool: string,
  { live }: { live: () => boolean },
): Promise<KimiUnloadRepair> {
  if (live()) return { status: 'refused', reason: 'live' };
  if (!path.isAbsolute(home) || !path.isAbsolute(cwd) || !KIMI_SESSION_ID.test(sessionId)) return { status: 'refused', reason: 'invalid' };
  const file = path.join(await realpath(home), 'sessions', workspaceKey(cwd), sessionId, 'agents', 'main', 'wire.jsonl');
  let fd;
  try {
    if (await realpath(file) !== file) return { status: 'refused', reason: 'invalid' };
    fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await fd.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size === 0) return { status: 'refused', reason: 'invalid' };
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await fd.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) return { status: 'refused', reason: 'changed' };
      offset += bytesRead;
    }
    const after = await fd.stat();
    const name = await lstat(file);
    if (!name.isFile() || name.dev !== before.dev || name.ino !== before.ino || await realpath(file) !== file) return { status: 'refused', reason: 'invalid' };
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
        name.size !== after.size || name.mtimeMs !== after.mtimeMs) return { status: 'refused', reason: 'changed' };
    if (bytes.at(-1) !== 10) return { status: 'refused', reason: 'invalid' };

    // Keep the raw line bytes: the rewrite reuses them verbatim, never re-serialized JSON.
    const raw: Buffer[] = [];
    for (let start = 0; start < bytes.length;) {
      const end = bytes.indexOf(10, start);
      if (end === -1) return { status: 'refused', reason: 'invalid' };
      raw.push(bytes.subarray(start, end + 1));
      start = end + 1;
    }
    const decode = new TextDecoder('utf-8', { fatal: true });
    const rows: WireRow[] = [];
    for (const line of raw) {
      let row: Record<string, unknown> | undefined;
      try { row = record(JSON.parse(decode.decode(line.subarray(0, -1)))); } catch { return { status: 'refused', reason: 'invalid' }; }
      if (typeof row?.type !== 'string') return { status: 'refused', reason: 'invalid' };
      rows.push(row as WireRow);
    }
    const header = rows[0];
    if (header?.type !== 'metadata' || header.protocol_version !== '1.5' || header.min_protocol_version !== '1.5') return { status: 'refused', reason: 'invalid' };

    const found = poisonedAnnouncements(rows);
    const targets = found.filter(entry => entry.removed.includes(tool));
    if (targets.length === 0) return { status: 'clean', poisoned: found.length };

    const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await writeFile(backup, bytes, { flag: 'wx', mode: 0o600 });

    const drop = new Set(targets.map(entry => entry.line));
    const kept = Buffer.concat(raw.filter((_, index) => !drop.has(index)));
    // A live process or a concurrent writer between the read and the write voids the repair.
    if (live()) return { status: 'refused', reason: 'live' };
    const now = await fd.stat();
    const current = await lstat(file);
    if (now.dev !== before.dev || now.ino !== before.ino || now.size !== before.size ||
        now.mtimeMs !== before.mtimeMs || now.ctimeMs !== before.ctimeMs ||
        !current.isFile() || current.dev !== before.dev || current.ino !== before.ino ||
        current.size !== before.size || current.mtimeMs !== before.mtimeMs || await realpath(file) !== file) {
      return { status: 'refused', reason: 'changed' };
    }
    const tmp = `${file}.tmp-${randomUUID()}`;
    try {
      const out = await open(tmp, 'w', 0o600);
      try {
        await out.writeFile(kept);
        await out.sync();
      } finally {
        await out.close();
      }
      await rename(tmp, file);
    } catch (error) {
      await unlink(tmp).catch(() => {});
      throw error;
    }
    return { status: 'repaired', backup, removed: targets.length, poisoned: found.length };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'refused', reason: 'invalid' };
    throw error;
  } finally {
    await fd?.close();
  }
}
