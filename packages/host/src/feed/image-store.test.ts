/**
 * Хранилище картинок ленты (план 2026-10-09, Task 3): файлы в каталоге хоста, имя — первые 24 hex sha256
 * и расширение по типу, каталог 0700, файлы 0600, предел размера, sweep по сроку. Исключений наружу нет:
 * отказ — `null`, а ошибка файловой системы ещё и одна строка в консоль без данных.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEED_IMAGE_MAX_BYTES, FEED_IMAGE_TTL_MS } from '@parley/core';
import { makePng } from '../../test/png.js';
import { createFeedImageStore } from './image-store.js';

const DAY = 24 * 60 * 60 * 1000;
const MIB = 1024 * 1024;

const b64 = (bytes: Buffer): string => bytes.toString('base64');
const sha24 = (bytes: Buffer): string =>
  createHash('sha256').update(bytes).digest('hex').slice(0, 24);
const inThePast = (ms: number): Date => new Date(Date.now() - ms);

let root: string;
let dir: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'feed-image-store-'));
  // Каталога ещё нет и родителя тоже: хранилище заводит их само.
  dir = path.join(root, 'nested', 'feed-images');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('save', () => {
  it('PNG пишется внутрь каталога: имя — sha256 и расширение, файл 0600, каталог 0700, ссылка с типом и размером', () => {
    const png = makePng();
    const ref = createFeedImageStore({ dir }).save(b64(png), 'image/png');

    expect(ref).toEqual({
      path: path.join(dir, `${sha24(png)}.png`),
      mime: 'image/png',
      bytes: png.length,
    });
    const file = ref?.path ?? '';
    expect(path.dirname(file)).toBe(dir);
    expect(readFileSync(file).equals(png)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    // Временного файла записи после себя не оставляет.
    expect(readdirSync(dir)).toEqual([`${sha24(png)}.png`]);
  });

  it('та же картинка — тот же путь, файл один и повторно не переписывается', () => {
    const store = createFeedImageStore({ dir });
    const png = makePng();
    const first = store.save(b64(png), 'image/png');
    const old = inThePast(DAY);
    utimesSync(first?.path ?? '', old, old);

    const second = store.save(b64(png), 'image/png');

    expect(second).toEqual(first);
    expect(readdirSync(dir)).toHaveLength(1);
    expect(Math.abs(statSync(first?.path ?? '').mtimeMs - old.getTime())).toBeLessThan(1000);
  });

  it('разные картинки — разные файлы', () => {
    const store = createFeedImageStore({ dir });
    const one = store.save(b64(makePng(40, 30, 1)), 'image/png');
    const two = store.save(b64(makePng(40, 30, 2)), 'image/png');

    expect(one?.path).not.toBe(two?.path);
    expect(readdirSync(dir)).toHaveLength(2);
  });

  it('расширение по типу: png, jpeg — jpg, webp, gif; ссылка несёт тот же тип', () => {
    const store = createFeedImageStore({ dir });
    const saved = (mime: string): [string, string | undefined] => {
      const ref = store.save(b64(Buffer.from(`bytes of ${mime}`)), mime);
      return [path.extname(ref?.path ?? ''), ref?.mime];
    };

    expect(saved('image/png')).toEqual(['.png', 'image/png']);
    expect(saved('image/jpeg')).toEqual(['.jpg', 'image/jpeg']);
    expect(saved('image/webp')).toEqual(['.webp', 'image/webp']);
    expect(saved('image/gif')).toEqual(['.gif', 'image/gif']);
  });

  it('неизвестный тип — null, на диске ничего, даже каталога', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createFeedImageStore({ dir });
    const data = b64(makePng());

    // Тип приходит из чужого результата: имена из прототипа объекта (`constructor`) — тоже неизвестные.
    const unknown = [
      'image/svg+xml',
      'text/html',
      'application/octet-stream',
      'image/jpg',
      'image/',
      '',
      'constructor',
      '__proto__',
      'toString',
    ];
    for (const mime of unknown) {
      expect(store.save(data, mime)).toBeNull();
    }
    expect(existsSync(dir)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('пустые или битые данные — null, без предупреждения и без файлов', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createFeedImageStore({ dir });

    for (const data of [
      '',
      '   ',
      '====',
      '!!!not base64!!!',
      'abc$def',
      'aG=Vs',
      'data:image/png;base64,AAAA',
    ]) {
      expect(store.save(data, 'image/png')).toBeNull();
    }
    expect(existsSync(dir)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('base64 с переводами строк или без паддинга годится: хранилище читает так же, как Node', () => {
    const store = createFeedImageStore({ dir });
    const png = makePng();
    const wrapped = b64(png).replace(/(.{76})/g, '$1\n');
    const unpadded = b64(png).replace(/=+$/, '');
    expect(unpadded).not.toBe(b64(png));

    for (const data of [wrapped, unpadded]) {
      const ref = store.save(data, 'image/png');
      expect(readFileSync(ref?.path ?? '').equals(png)).toBe(true);
    }
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it('предел maxBytes: ровно предел — файл, на байт больше — null', () => {
    const store = createFeedImageStore({ dir, maxBytes: 100 });

    expect(store.save(b64(Buffer.alloc(100, 1)), 'image/png')?.bytes).toBe(100);
    expect(store.save(b64(Buffer.alloc(101, 2)), 'image/png')).toBeNull();
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it('по умолчанию предел — FEED_IMAGE_MAX_BYTES: 21 МиБ — null, ровно 20 МиБ — файл', () => {
    const store = createFeedImageStore({ dir });

    expect(store.save(b64(Buffer.alloc(21 * MIB, 3)), 'image/png')).toBeNull();
    expect(existsSync(dir)).toBe(false);
    const ref = store.save(b64(Buffer.alloc(FEED_IMAGE_MAX_BYTES, 4)), 'image/png');
    expect(ref?.bytes).toBe(FEED_IMAGE_MAX_BYTES);
    expect(statSync(ref?.path ?? '').size).toBe(FEED_IMAGE_MAX_BYTES);
  });

  it('ошибка файловой системы — null и одна строка в консоль: код ошибки, без данных; исключения нет', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Родитель каталога картинок — обычный файл: создать каталог нельзя.
    const blocker = path.join(root, 'blocker');
    writeFileSync(blocker, 'x');
    const store = createFeedImageStore({ dir: path.join(blocker, 'feed-images') });
    const data = b64(makePng());

    expect(store.save(data, 'image/png')).toBeNull();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[parley] feed image', 'ENOTDIR');
    expect(JSON.stringify(warn.mock.calls)).not.toContain(data.slice(0, 24));
  });

  it('вместо строки пришёл мусор — всё равно null, а не исключение', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createFeedImageStore({ dir });

    for (const data of [undefined, null, 42, {}]) {
      expect(store.save(data as unknown as string, 'image/png')).toBeNull();
    }
    expect(existsSync(dir)).toBe(false);
    // Это не ошибка файловой системы, но предупреждение остаётся без данных: только код.
    for (const call of warn.mock.calls)
      expect(call).toEqual(['[parley] feed image', expect.any(String)]);
  });
});

describe('sweep', () => {
  /** Имя, под которым хранилище кладёт файл; для файлов, подложенных руками. */
  const stored = (seed: number, ext = 'png'): string =>
    path.join(dir, `${sha24(makePng(40, 30, seed))}.${ext}`);

  it('файл старше 7 суток уходит, свежий остаётся; чужие файлы и каталоги не трогаются', () => {
    const now = Date.now();
    const store = createFeedImageStore({ dir, now: () => now });
    const old = store.save(b64(makePng(40, 30, 1)), 'image/png')?.path ?? '';
    const fresh = store.save(b64(makePng(40, 30, 2)), 'image/png')?.path ?? '';
    const almost = store.save(b64(makePng(40, 30, 3)), 'image/png')?.path ?? '';
    const stale = new Date(now - FEED_IMAGE_TTL_MS - 1000);
    utimesSync(old, stale, stale);
    utimesSync(
      almost,
      new Date(now - FEED_IMAGE_TTL_MS + DAY),
      new Date(now - FEED_IMAGE_TTL_MS + DAY),
    );
    // Забытый временный файл записи тоже старше срока; чужие — по имени не наши.
    const leftover = `${stored(4)}.tmp`;
    const foreign = path.join(dir, 'notes.txt');
    const folder = path.join(dir, 'a'.repeat(24) + '.png');
    writeFileSync(leftover, 'half');
    writeFileSync(foreign, 'mine');
    mkdirSync(folder);
    for (const item of [leftover, foreign, folder]) utimesSync(item, stale, stale);

    store.sweep();

    expect(existsSync(old)).toBe(false);
    expect(existsSync(leftover)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(almost)).toBe(true);
    expect(existsSync(foreign)).toBe(true);
    expect(existsSync(folder)).toBe(true);
  });

  it('срок считается от now(): через 6 суток всё цело, через 8 — ничего', () => {
    let now = Date.now();
    const store = createFeedImageStore({ dir, now: () => now });
    const file = store.save(b64(makePng()), 'image/png')?.path ?? '';

    now += 6 * DAY;
    store.sweep();
    expect(existsSync(file)).toBe(true);

    now += 2 * DAY;
    store.sweep();
    expect(existsSync(file)).toBe(false);
  });

  it('каталога нет — тихо: ничего не создаётся, ничего не выводится, исключения нет', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => createFeedImageStore({ dir }).sweep()).not.toThrow();

    expect(existsSync(dir)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});
