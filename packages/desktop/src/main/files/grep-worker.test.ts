import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GrepQuery } from '../../shared/files-types.js';
import { GREP_LIMITS, matchRanges, runJob, type GrepWorkerMessage } from './grep-worker.js';

const Q = (text: string, extra: Partial<GrepQuery> = {}): GrepQuery => ({
  text,
  caseSensitive: true,
  wholeWord: false,
  regex: false,
  ...extra,
});

describe('matchRanges', () => {
  it('текст без регулярки: спецсимволы как есть, все вхождения', () => {
    expect(matchRanges(Q('a.b'), 'a.b axb a.b')).toEqual([
      [0, 3],
      [8, 11],
    ]);
    expect(matchRanges(Q('(x'), 'f(x)')).toEqual([[1, 3]]);
  });

  it('регистр, слово, регулярка', () => {
    expect(matchRanges(Q('foo'), 'Foo foo')).toEqual([[4, 7]]);
    expect(matchRanges(Q('foo', { caseSensitive: false }), 'Foo foo')).toEqual([
      [0, 3],
      [4, 7],
    ]);
    expect(matchRanges(Q('foo', { wholeWord: true }), 'foobar foo_x foo.')).toEqual([[13, 16]]);
    expect(matchRanges(Q('o+', { regex: true }), 'foo boooo')).toEqual([
      [1, 3],
      [5, 9],
    ]);
  });

  it('кодовые единицы: эмодзи и кириллица', () => {
    expect(matchRanges(Q('ё'), '😀ё')).toEqual([[2, 3]]);
  });

  it('пустое совпадение не зацикливает; битая регулярка — пусто', () => {
    expect(matchRanges(Q('x*', { regex: true }), 'abc')).toEqual([]);
    expect(matchRanges(Q('(', { regex: true }), 'a(b')).toEqual([]);
  });
});

describe('runJob', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(path.join(tmpdir(), 'harnas-grepworker-')));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const collect = (job: Parameters<typeof runJob>[0]): GrepWorkerMessage[] => {
    const out: GrepWorkerMessage[] = [];
    runJob(job, (message) => out.push(message));
    return out;
  };

  it('ranges: по файлу на сообщение, затем done', () => {
    const messages = collect({
      kind: 'ranges',
      query: Q('ab'),
      files: [{ path: 'x', hits: [{ line: 1, text: 'ab ab', ranges: [] }] }],
    });
    expect(messages).toEqual([
      { type: 'file', file: { path: 'x', hits: [{ line: 1, text: 'ab ab', ranges: [[0, 2], [3, 5]] }] } },
      { type: 'done', truncated: false },
    ]);
  });

  it('walk: FIFO и файл больше 20 МБ пропускаются, двоичный — тоже', async () => {
    execFileSync('mkfifo', [path.join(dir, 'pipe')]);
    await writeFile(path.join(dir, 'big.txt'), Buffer.alloc(20 * 1024 * 1024 + 1, 0x61));
    await writeFile(path.join(dir, 'bin'), Buffer.from('aaa\0'));
    await writeFile(path.join(dir, 'ok.txt'), 'x\naaa\n');
    const started = Date.now();
    const messages = collect({ kind: 'walk', query: Q('aaa'), rootPath: dir, paths: ['pipe', 'big.txt', 'bin', 'ok.txt'] });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(messages).toEqual([
      { type: 'file', file: { path: 'ok.txt', hits: [{ line: 2, text: 'aaa', ranges: [[0, 3]] }] } },
      { type: 'done', truncated: false },
    ]);
  });

  it('walk: 2000 совпадений предел, дальше truncated', async () => {
    await writeFile(path.join(dir, 'a.txt'), 'hit\n'.repeat(1500));
    await writeFile(path.join(dir, 'b.txt'), 'hit\n'.repeat(1500));
    const messages = collect({ kind: 'walk', query: Q('hit'), rootPath: dir, paths: ['a.txt', 'b.txt'] });
    const hits = messages.flatMap((m) => (m.type === 'file' ? m.file.hits : []));
    expect(hits).toHaveLength(GREP_LIMITS.hits);
    expect(messages.at(-1)).toEqual({ type: 'done', truncated: true });
  });

  it('walk: путь, ушедший наружу по ссылке, не читается', async () => {
    const outside = await realpath(await mkdtemp(path.join(tmpdir(), 'harnas-grepworker-out-')));
    try {
      await writeFile(path.join(outside, 's.txt'), 'needle\n');
      execFileSync('ln', ['-s', path.join(outside, 's.txt'), path.join(dir, 'l.txt')]);
      expect(collect({ kind: 'walk', query: Q('needle'), rootPath: dir, paths: ['l.txt'] })).toEqual([
        { type: 'done', truncated: false },
      ]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
