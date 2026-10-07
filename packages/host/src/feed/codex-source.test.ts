import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRolloutTail } from './codex-source.js';

const line = (ordinal: number, text = 'x'): string =>
  JSON.stringify({ timestamp: '2026-10-07T10:00:00.000Z', ordinal, type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', id: `m${ordinal}`, content: [{ type: 'text', text }] } } });

let dir = '';
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'codex-tail-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('createRolloutTail', () => {
  it('файла нет — пусто; появился — читается с начала', async () => {
    const file = path.join(dir, 'rollout.jsonl');
    const tail = createRolloutTail(file);
    expect(await tail.read()).toEqual([]);
    await writeFile(file, `${line(0)}\n${line(1)}\n`);
    expect((await tail.read()).map((record) => record.ordinal)).toEqual([0, 1]);
    expect(await tail.read()).toEqual([]);
  });

  it('строка разрезана между записями — один элемент, целиком (Review Focus 2)', async () => {
    const file = path.join(dir, 'rollout.jsonl');
    const full = line(5, 'кириллица и длинный текст '.repeat(20));
    const cut = Buffer.from(full, 'utf8');
    await writeFile(file, `${line(4)}\n`);
    await appendFile(file, cut.subarray(0, 101)); // режем посреди многобайтового символа
    const tail = createRolloutTail(file);
    expect((await tail.read()).map((record) => record.ordinal)).toEqual([4]);
    await appendFile(file, Buffer.concat([cut.subarray(101), Buffer.from('\n')]));
    const next = await tail.read();
    expect(next.map((record) => record.ordinal)).toEqual([5]);
    expect(JSON.stringify(next[0]?.payload)).toContain('кириллица');
  });

  it('файл стал короче (пересоздан) — чтение с начала', async () => {
    const file = path.join(dir, 'rollout.jsonl');
    await writeFile(file, `${line(0)}\n${line(1)}\n${line(2)}\n`);
    const tail = createRolloutTail(file);
    await tail.read();
    await writeFile(file, `${line(9)}\n`);
    expect((await tail.read()).map((record) => record.ordinal)).toEqual([9]);
  });

  it('первое чтение большого файла — только хвост, первая неполная строка отброшена', async () => {
    const file = path.join(dir, 'rollout.jsonl');
    await writeFile(file, Array.from({ length: 100 }, (_, n) => line(n)).join('\n') + '\n');
    const tail = createRolloutTail(file, { seedMaxBytes: 2_000 });
    const records = await tail.read();
    expect(records.length).toBeGreaterThan(0);
    expect(records.length).toBeLessThan(100);
    expect(records.at(-1)?.ordinal).toBe(99);
  });
});
