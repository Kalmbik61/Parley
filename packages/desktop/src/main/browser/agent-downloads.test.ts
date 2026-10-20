import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AGENT_LIMITS } from '@parley/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentDownloads } from './agent-downloads.js';

const OWNER = { workKey: '/a w-1', sessionId: 's-02', agentId: 'claude', tab: 't1' };

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'agent-dl-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

interface FakeItem extends EventEmitter {
  getFilename: () => string;
  getURL: () => string;
  getTotalBytes: () => number;
  getReceivedBytes: () => number;
  setSavePath: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  getState: () => string;
  progress(bytes: number): void;
  finish(state: string): void;
}

function item(name: string, url = 'https://example.test/file'): FakeItem {
  let received = 0;
  let state = 'progressing';
  const base = new EventEmitter();
  return Object.assign(base, {
    getFilename: () => name,
    getURL: () => url,
    getTotalBytes: () => 0,
    getReceivedBytes: () => received,
    setSavePath: vi.fn(),
    cancel: vi.fn(),
    getState: () => state,
    progress(bytes: number) {
      received = bytes;
      base.emit('updated', {}, 'progressing');
    },
    finish(next: string) {
      state = next;
      base.emit('done', {}, next);
    },
  }) as FakeItem;
}

const asItem = (value: FakeItem) => value as unknown as import('electron').DownloadItem;

describe('скачивания агента (Фокус ревью 7)', () => {
  it('claim — путь в папке сессии без диалога; имя — basename без управляющих символов; повтор имени — (2)', async () => {
    const downloads = createAgentDownloads({ root });
    const one = item('../../evil\u0007.csv', 'https://example.test/report.csv?token=SECRET');
    const first = downloads.claim(asItem(one), OWNER);
    expect(first.path).toBe(path.join(downloads.dirOf(OWNER.workKey, OWNER.sessionId), 'evil.csv'));
    expect(one.setSavePath).toHaveBeenCalledWith(first.path);
    expect(first.url).toBe('https://example.test/report.csv?token=<redacted>');
    expect(first).toMatchObject({ state: 'progressing', tab: 't1', name: 'evil.csv' });
    const second = downloads.claim(asItem(item('evil.csv')), OWNER);
    // Без страницы-источника — tab null, а не чужая t1 (рецензия пачки 2).
    expect(downloads.claim(asItem(item('other.csv')), { ...OWNER, tab: undefined })).toMatchObject({ tab: null });
    expect(path.basename(second.path)).toBe('evil (2).csv');
    expect((await stat(downloads.dirOf(OWNER.workKey, OWNER.sessionId))).mode & 0o777).toBe(0o700);
  });

  it('done: completed — файл 0600; больше downloadBytes — отмена и заметка', async () => {
    const downloads = createAgentDownloads({ root });
    const okItem = item('a.bin');
    const ok = downloads.claim(asItem(okItem), OWNER);
    await writeFile(ok.path, 'x', { mode: 0o644 });
    okItem.finish('completed');
    await vi.waitFor(async () => expect((await stat(ok.path)).mode & 0o777).toBe(0o600));
    expect(downloads.list(OWNER.workKey, OWNER.sessionId)[0]).toMatchObject({ state: 'completed' });
    const big = item('big.iso');
    downloads.claim(asItem(big), OWNER);
    big.progress(AGENT_LIMITS.downloadBytes + 1);
    expect(big.cancel).toHaveBeenCalled();
    expect(downloads.list(OWNER.workKey, OWNER.sessionId).at(-1)?.note).toContain('200 MB');
  });

  it('list — только своей сессии, не больше 20, новые последними; dirOf у разных работ различается', () => {
    const downloads = createAgentDownloads({ root });
    for (let i = 0; i < 25; i += 1) downloads.claim(asItem(item(`f${i}.txt`)), OWNER);
    downloads.claim(asItem(item('other.txt')), { ...OWNER, sessionId: 's-03' });
    const list = downloads.list(OWNER.workKey, OWNER.sessionId);
    expect(list).toHaveLength(AGENT_LIMITS.downloads);
    expect(list.at(-1)?.name).toBe('f24.txt');
    expect(downloads.dirOf('/a w-1', 's-02')).not.toBe(downloads.dirOf('/b w-1', 's-02'));
  });

  it('sweep — файлы старше срока удаляются во всех папках сессий; опустевшие папки — тоже', async () => {
    const downloads = createAgentDownloads({ root });
    const oldDir = downloads.dirOf('/old', 's-01');
    const freshDir = downloads.dirOf('/fresh', 's-02');
    await mkdir(oldDir, { recursive: true });
    await mkdir(freshDir, { recursive: true });
    const now = Date.now();
    const eight = new Date(now - 8 * 24 * 60 * 60 * 1000);
    await writeFile(path.join(oldDir, 'old.txt'), 'x');
    await utimes(path.join(oldDir, 'old.txt'), eight, eight);
    await writeFile(path.join(freshDir, 'new.txt'), 'x');
    const removed = await downloads.sweep(AGENT_LIMITS.downloadDays * 24 * 60 * 60 * 1000, now);
    expect(removed).toBe(1);
    await expect(stat(oldDir)).rejects.toThrow();
    await expect(stat(path.dirname(oldDir))).rejects.toThrow();
    await expect(stat(path.join(freshDir, 'new.txt'))).resolves.toBeTruthy();
  });

  it('уже существующая папка сессии с правами 0755 — после claim 0700', async () => {
    const downloads = createAgentDownloads({ root });
    const dir = downloads.dirOf(OWNER.workKey, OWNER.sessionId);
    await mkdir(dir, { recursive: true, mode: 0o755 });
    downloads.claim(asItem(item('a.txt')), OWNER);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });
});
