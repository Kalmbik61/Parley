import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readJsonlRecords } from './jsonl.js';

let dir: string;
const write = async (name: string, content: string) => {
  const file = path.join(dir, name);
  await writeFile(file, content);
  return file;
};

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'parley-jsonl-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('readJsonlRecords', () => {
  it('читает записи построчно', async () => {
    const file = await write('ok.jsonl', '{"type":"user"}\n{"type":"assistant"}\n');
    const { records, stats } = await readJsonlRecords(file);
    expect(records).toEqual([{ type: 'user' }, { type: 'assistant' }]);
    expect(stats).toEqual({ lines: 2, parsed: 2, malformed: 0, lastLineMalformed: false });
  });

  it('оборванная последняя строка живой сессии — не ошибка', async () => {
    const file = await write('live.jsonl', '{"type":"user"}\n{"type":"assi');
    const { records, stats } = await readJsonlRecords(file);
    expect(records).toEqual([{ type: 'user' }]);
    expect(stats.malformed).toBe(1);
    expect(stats.lastLineMalformed).toBe(true);
  });

  it('битая строка в середине не роняет чтение', async () => {
    const file = await write('broken.jsonl', '{"a":1}\n{ мусор\n{"b":2}\n');
    const { records, stats } = await readJsonlRecords(file);
    expect(records).toEqual([{ a: 1 }, { b: 2 }]);
    expect(stats.malformed).toBe(1);
    expect(stats.lastLineMalformed).toBe(false);
  });

  it('пустые строки пропускаются и не считаются', async () => {
    const file = await write('blank.jsonl', '\n{"a":1}\n\n\n');
    const { records, stats } = await readJsonlRecords(file);
    expect(records).toEqual([{ a: 1 }]);
    expect(stats.lines).toBe(1);
  });

  it('пустой файл — пустой результат, не ошибка', async () => {
    const file = await write('empty.jsonl', '');
    const { records, stats } = await readJsonlRecords(file);
    expect(records).toEqual([]);
    expect(stats).toEqual({ lines: 0, parsed: 0, malformed: 0, lastLineMalformed: false });
  });

  it('валидный JSON, но не объект — считается битой строкой', async () => {
    const file = await write('scalar.jsonl', '42\n"строка"\n[1,2]\n{"a":1}\n');
    const { records, stats } = await readJsonlRecords(file);
    expect(records).toEqual([{ a: 1 }]);
    expect(stats.malformed).toBe(3);
  });
});
