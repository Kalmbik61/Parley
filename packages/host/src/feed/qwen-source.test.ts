import { appendFile, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createQwenTail } from './qwen-source.js';

const line = (n: number, text = 'x'): string =>
  JSON.stringify({ uuid: `u${n}`, sessionId: 's', timestamp: '2026-11-11T10:00:00.000Z', type: 'user', provenance: 'real_user', message: { parts: [{ text }] } });

let dir = '';
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'qwen-tail-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('createQwenTail', () => {
  it('a missing file gives nothing; when it appears it is read from the start, then only what was appended', async () => {
    const file = path.join(dir, 's.jsonl');
    const tail = createQwenTail(file);
    expect(await tail.read()).toEqual([]);
    await writeFile(file, `${line(1)}\n${line(2)}\n`);
    expect((await tail.read()).map((r) => r.uuid)).toEqual(['u1', 'u2']);
    expect(await tail.read()).toEqual([]);
    await appendFile(file, `${line(3)}\n`);
    expect((await tail.read()).map((r) => r.uuid)).toEqual(['u3']);
  });

  it('a line cut in the middle of a multi-byte character is delivered whole, once', async () => {
    const file = path.join(dir, 's.jsonl');
    const bytes = Buffer.from(line(5, 'кириллица '.repeat(20)), 'utf8');
    await writeFile(file, `${line(4)}\n`);
    await appendFile(file, bytes.subarray(0, 150));
    const tail = createQwenTail(file);
    expect((await tail.read()).map((r) => r.uuid)).toEqual(['u4']);
    await appendFile(file, Buffer.concat([bytes.subarray(150), Buffer.from('\n')]));
    expect((await tail.read()).map((r) => r.uuid)).toEqual(['u5']);
  });

  it('a shorter file is read again from the start; a broken line is skipped', async () => {
    const file = path.join(dir, 's.jsonl');
    await writeFile(file, `${line(1)}\n${line(2)}\n`);
    const tail = createQwenTail(file);
    await tail.read();
    await truncate(file, 0);
    await writeFile(file, `{broken\n${line(9)}\n`);
    expect((await tail.read()).map((r) => r.uuid)).toEqual(['u9']);
  });

  it('a big file is seeded from a tail: the first partial line is dropped', async () => {
    const file = path.join(dir, 's.jsonl');
    await writeFile(file, Array.from({ length: 50 }, (_, i) => line(i)).join('\n') + '\n');
    const tail = createQwenTail(file, { seedMaxBytes: 400 });
    const got = await tail.read();
    expect(got.length).toBeGreaterThan(0);
    expect(got.length).toBeLessThan(10);
    expect(got.at(-1)?.uuid).toBe('u49');
  });
});
