import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { workspaceKey } from './date-provenance.js';
import { projectKimiWire, record, type WireRow } from './native-wire.js';
import { repairKimiUnloadPoison } from './unload-repair.js';

// Opt-in probe on the real poisoned wire of session s-32 (audit 2026-11-26):
//   PARLEY_KIMI_POISON_WIRE=~/.kimi-code/sessions/wd_tdhc_335bf131e8fe/session_893c961c-…/agents/main/wire.jsonl \
//     pnpm --filter @parley/host test unload-poison
// The original is only ever read; every write lands on a copy in a temporary home.
const source = process.env['PARLEY_KIMI_POISON_WIRE'];

it.skipIf(!source)('detects and repairs the real poisoned wire on a copy, byte-for-byte', async () => {
  if (!source || !path.isAbsolute(source)) throw new Error('PARLEY_KIMI_POISON_WIRE must be an absolute wire path');
  const sessionId = path.basename(path.dirname(path.dirname(path.dirname(source))));
  const home = await mkdtemp(path.join(tmpdir(), 'parley-kimi-poison-probe-'));
  const cwd = '/private/tmp/poison-probe';
  const file = path.join(home, 'sessions', workspaceKey(cwd), sessionId, 'agents', 'main', 'wire.jsonl');
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await copyFile(source, file);
    // The source may be a live wire: keep only complete lines in the snapshot, as the reader does.
    const copied = await readFile(file);
    if (copied.at(-1) !== 10) await writeFile(file, copied.subarray(0, copied.lastIndexOf(10) + 1));
    const original = await readFile(file);
    const raw: Buffer[] = [];
    for (let start = 0; start < original.length;) {
      const end = original.indexOf(10, start);
      raw.push(original.subarray(start, end + 1));
      start = end + 1;
    }
    const rows = raw.map(line => JSON.parse(line.toString('utf8')) as WireRow);

    // Detection on the real failures: the unload_tools 400 matches, the schema-size 400 does not.
    const ends = rows.map(row => projectKimiWire(row)).filter(event => event?.kind === 'end');
    const poisoned = ends.filter(event => event?.kind === 'end' && event.poison !== undefined);
    expect(poisoned.length).toBeGreaterThanOrEqual(1);
    const schemaFailures = rows.filter(row => row.type === 'turn.ended' && row.reason === 'failed' &&
      typeof record(row.error)?.message === 'string' && (record(row.error)!.message as string).includes('moonshot flavored json schema'));
    expect(schemaFailures.length).toBeGreaterThanOrEqual(1);
    for (const row of schemaFailures) expect(projectKimiWire(row)).not.toHaveProperty('poison');
    const firstTool = poisoned[0]!.kind === 'end' ? poisoned[0]!.poison!.tool : '';
    expect(firstTool).toMatch(/^mcp__figma-dev-mode-mcp-server__/);

    const binding = { home, cwd, sessionId };
    const stopped = { live: () => false };
    const expectedAfter = (tool: string): Buffer => {
      let compaction = -1;
      rows.forEach((row, index) => { if (row.type === 'context.apply_compaction') compaction = index; });
      return Buffer.concat(raw.filter((line, index) => {
        if (index <= compaction) return true;
        const row = rows[index]!;
        if (row.type !== 'context.append_message' || row.agentId !== 'main') return true;
        const parts = record(row.message)?.content;
        if (!Array.isArray(parts)) return true;
        return !parts.some(part => {
          const meta = record(record(part)?.meta);
          return meta?.kind === 'tool_lifecycle' && Array.isArray(meta.removed) && meta.removed.includes(tool);
        });
      }));
    };

    // First repair: the announcement naming the figma tool; the parley announcement stays.
    const first = await repairKimiUnloadPoison(binding, firstTool, stopped);
    expect(first).toMatchObject({ status: 'repaired', removed: 1, poisoned: 2 });
    // Buffer.equals: a deep-equal of two 11 MB buffers is minutes of element-wise comparison.
    expect((await readFile(file)).equals(expectedAfter(firstTool))).toBe(true);
    if (first.status !== 'repaired') throw new Error('unreachable');
    expect((await readFile(first.backup)).equals(original)).toBe(true);

    // The next failure would name a parley tool: repair that announcement too.
    const remaining = (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as WireRow);
    const nextTool = remaining.flatMap(row => {
      const parts = record(row.message)?.content;
      return Array.isArray(parts) ? parts : [];
    }).map(part => record(record(part)?.meta)).find(meta => meta?.kind === 'tool_lifecycle' && Array.isArray(meta.removed) && meta.removed.length > 0)?.removed[0];
    expect(typeof nextTool).toBe('string');
    expect(nextTool).toMatch(/^mcp__parley__/);
    const second = await repairKimiUnloadPoison(binding, nextTool as string, stopped);
    expect(second).toMatchObject({ status: 'repaired', removed: 1, poisoned: 1 });

    // Idempotent afterwards: nothing left to repair, no third backup.
    expect(await repairKimiUnloadPoison(binding, firstTool, stopped)).toEqual({ status: 'clean', poisoned: 0 });
    const final = await readFile(file);
    expect(final.length).toBeLessThan(original.length);
    // Every surviving line is byte-identical to its original.
    const originalLines = new Set(raw.map(line => line.toString('latin1')));
    let strangers = 0;
    for (let start = 0; start < final.length;) {
      const end = final.indexOf(10, start);
      if (!originalLines.has(final.subarray(start, end + 1).toString('latin1'))) strangers += 1;
      start = end + 1;
    }
    expect(strangers).toBe(0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 30_000);
