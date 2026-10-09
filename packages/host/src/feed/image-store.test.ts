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

/**
 * Настоящий «диск полон» или чужой владелец файла в тесте не получить, поэтому запись на диск и смену времени
 * файла можно оборвать по требованию: при записи часть байтов ложится в файл, и летит ошибка. Всё остальное в
 * `node:fs` — настоящее.
 */
const disk = vi.hoisted(() => ({
  failNextWrite: null as NodeJS.ErrnoException | null,
  failNextUtimes: null as NodeJS.ErrnoException | null,
  failNextReaddir: null as NodeJS.ErrnoException | null,
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: ((...args: Parameters<typeof actual.writeFileSync>) => {
      const failure = disk.failNextWrite;
      if (failure === null) return actual.writeFileSync(...args);
      disk.failNextWrite = null;
      actual.writeFileSync(args[0], 'partial', { mode: 0o600 });
      throw failure;
    }) as typeof actual.writeFileSync,
    utimesSync: ((...args: Parameters<typeof actual.utimesSync>) => {
      const failure = disk.failNextUtimes;
      if (failure === null) return actual.utimesSync(...args);
      disk.failNextUtimes = null;
      throw failure;
    }) as typeof actual.utimesSync,
    readdirSync: ((...args: Parameters<typeof actual.readdirSync>) => {
      const failure = disk.failNextReaddir;
      if (failure === null) return actual.readdirSync(...args);
      disk.failNextReaddir = null;
      throw failure;
    }) as typeof actual.readdirSync,
  };
});

const DAY = 24 * 60 * 60 * 1000;
const MIB = 1024 * 1024;

const b64 = (bytes: Buffer): string => bytes.toString('base64');
const sha24 = (bytes: Buffer): string =>
  createHash('sha256').update(bytes).digest('hex').slice(0, 24);
const inThePast = (ms: number): Date => new Date(Date.now() - ms);

/** Подпись начала файла каждого типа картинок, как её ждёт хранилище. */
const SIGNATURES = {
  'image/png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/jpeg': Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  'image/gif': Buffer.from('GIF89a', 'latin1'),
  'image/webp': Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]),
} as const;
type ImageMime = keyof typeof SIGNATURES;

/** Байты «картинки» заданного типа и размера: подпись типа и заполнитель; для проверок размера и имени файла. */
function imageBytes(mime: ImageMime, size = 64, fill = 7): Buffer {
  const bytes = Buffer.alloc(size, fill);
  SIGNATURES[mime].copy(bytes, 0, 0, Math.min(size, SIGNATURES[mime].length));
  return bytes;
}

let root: string;
let dir: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'feed-image-store-'));
  // Каталога ещё нет и родителя тоже: хранилище заводит их само.
  dir = path.join(root, 'nested', 'feed-images');
});

afterEach(async () => {
  vi.restoreAllMocks();
  disk.failNextWrite = null;
  disk.failNextUtimes = null;
  disk.failNextReaddir = null;
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

  it('та же картинка — тот же путь, файл один и не переписывается, а время файла обновляется', () => {
    const store = createFeedImageStore({ dir });
    const png = makePng();
    const first = store.save(b64(png), 'image/png');
    const old = inThePast(6 * DAY);
    utimesSync(first?.path ?? '', old, old);
    const before = statSync(first?.path ?? '');

    const second = store.save(b64(png), 'image/png');

    expect(second).toEqual(first);
    expect(readdirSync(dir)).toHaveLength(1);
    const after = statSync(first?.path ?? '');
    // Тот же файл (запись через временный дала бы новый inode), но «виден» только что.
    expect(after.ino).toBe(before.ino);
    expect(Date.now() - after.mtimeMs).toBeLessThan(1000);
  });

  it('картинку, на которую лента ссылается снова, срок не берёт: повторная запись продлевает файлу жизнь', () => {
    let now = Date.now();
    const store = createFeedImageStore({ dir, now: () => now });
    const shown = store.save(b64(makePng(40, 30, 1)), 'image/png')?.path ?? '';
    const forgotten = store.save(b64(makePng(40, 30, 2)), 'image/png')?.path ?? '';
    const old = new Date(now - 6 * DAY);
    for (const file of [shown, forgotten]) utimesSync(file, old, old);

    // От первой записи прошёл месяц, но живая лента снова ссылается на первую картинку: время файла берётся
    // по часам хранилища, как и срок в sweep.
    now += 30 * DAY;
    store.save(b64(makePng(40, 30, 1)), 'image/png');
    store.sweep();

    expect(existsSync(shown)).toBe(true);
    expect(existsSync(forgotten)).toBe(false);
  });

  it('время файла не обновилось (чужой владелец, только чтение) — ссылка всё равно годится, тихо', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createFeedImageStore({ dir });
    const png = makePng();
    const first = store.save(b64(png), 'image/png');
    disk.failNextUtimes = Object.assign(new Error('operation not permitted'), { code: 'EPERM' });

    expect(store.save(b64(png), 'image/png')).toEqual(first);

    expect(warn).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual([`${sha24(png)}.png`]);
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
    const saved = (mime: ImageMime): [string, string | undefined] => {
      const ref = store.save(b64(imageBytes(mime)), mime);
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

  it('байты не того типа, что назван: текст и чужие картинки под видом PNG, JPEG, GIF, WebP — null, без файла и без предупреждения', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createFeedImageStore({ dir });
    const mimes = Object.keys(SIGNATURES) as ImageMime[];

    for (const mime of mimes) {
      // Текст, HTML и полуподпись не годятся ни для одного типа.
      for (const bytes of [
        Buffer.from('<html>not an image</html>'),
        Buffer.from('hello'),
        SIGNATURES[mime].subarray(0, 2),
      ]) {
        expect(store.save(b64(bytes), mime), `${mime}: ${bytes.toString('latin1')}`).toBeNull();
      }
      // Настоящая картинка другого типа — тоже нет.
      for (const other of mimes.filter((candidate) => candidate !== mime)) {
        expect(store.save(b64(imageBytes(other)), mime), `${other} как ${mime}`).toBeNull();
      }
    }
    expect(existsSync(dir)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    [
      'PNG: 89 50 4E 47',
      'image/png',
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      Buffer.from([0x89, 0x50, 0x4e, 0x46]),
    ],
    [
      'JPEG: FF D8 FF',
      'image/jpeg',
      Buffer.from([0xff, 0xd8, 0xff]),
      Buffer.from([0xff, 0xd8, 0xfe]),
    ],
    ['GIF: «GIF8»', 'image/gif', Buffer.from('GIF8'), Buffer.from('GIF7')],
    [
      'WebP: «RIFF», 4 любых байта, «WEBP»',
      'image/webp',
      Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBP')]),
      Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBX')]),
    ],
  ] as const)(
    'граница подписи — %s: ровно она годится, на байт иная — нет',
    (_title, mime, good, bad) => {
      const store = createFeedImageStore({ dir });

      expect(store.save(b64(good), mime)?.bytes).toBe(good.length);
      expect(store.save(b64(bad), mime)).toBeNull();
    },
  );

  it('WebP короче двенадцати байт — null, а не чтение за концом буфера', () => {
    const store = createFeedImageStore({ dir });

    expect(store.save(b64(Buffer.from('RIFF')), 'image/webp')).toBeNull();
    expect(store.save(b64(Buffer.from('RIFF\0\0\0\0WEB')), 'image/webp')).toBeNull();
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

    expect(store.save(b64(imageBytes('image/png', 100, 1)), 'image/png')?.bytes).toBe(100);
    expect(store.save(b64(imageBytes('image/png', 101, 2)), 'image/png')).toBeNull();
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it('по умолчанию предел — FEED_IMAGE_MAX_BYTES: 21 МиБ — null, ровно 20 МиБ — файл', () => {
    const store = createFeedImageStore({ dir });

    expect(store.save(b64(imageBytes('image/png', 21 * MIB, 3)), 'image/png')).toBeNull();
    expect(existsSync(dir)).toBe(false);
    const ref = store.save(b64(imageBytes('image/png', FEED_IMAGE_MAX_BYTES, 4)), 'image/png');
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
    // Это не ошибка файловой системы, но предупреждение остаётся без данных (только код) и одно на все четыре.
    expect(warn.mock.calls).toEqual([['[parley] feed image', 'ERR_INVALID_ARG_TYPE']]);
  });

  it('чужой результат не повод зависнуть: длинная цепочка пробелов с мусором в конце отвергается за миллисекунды', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createFeedImageStore({ dir });
    // Проверка base64 исполняется в onHook и при каждом севе: на таких строках она не должна расти быстрее длины.
    const hostile = [
      ' '.repeat(100_000) + '!',
      '\n'.repeat(100_000) + '!',
      ' '.repeat(50_000) + '=' + ' '.repeat(50_000) + '!',
      ' ='.repeat(50_000),
      'A'.repeat(100_000) + ' '.repeat(100_000) + '!',
    ];

    const started = performance.now();
    for (const data of hostile) expect(store.save(data, 'image/png')).toBeNull();

    // Квадратичная проверка тратила на первую строку несколько секунд, линейная — единицы миллисекунд.
    expect(performance.now() - started).toBeLessThan(500);
    expect(existsSync(dir)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('запись оборвалась на полпути (диск полон): временного файла не остаётся, null и одна строка с кодом; потом всё работает', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createFeedImageStore({ dir });
    const png = makePng();
    disk.failNextWrite = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });

    expect(store.save(b64(png), 'image/png')).toBeNull();

    expect(readdirSync(dir)).toEqual([]);
    expect(warn.mock.calls).toEqual([['[parley] feed image', 'ENOSPC']]);
    // Место появилось: та же картинка ложится как обычно.
    expect(store.save(b64(png), 'image/png')?.path).toBe(path.join(dir, `${sha24(png)}.png`));
    expect(readdirSync(dir)).toEqual([`${sha24(png)}.png`]);
  });

  it('постоянная ошибка не засоряет журнал: одна строка на код, другой код — своя строка', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createFeedImageStore({ dir });
    const failWith = (code: string, seed: number): void => {
      disk.failNextWrite = Object.assign(new Error(code), { code });
      expect(store.save(b64(makePng(40, 30, seed)), 'image/png')).toBeNull();
    };

    failWith('ENOSPC', 1);
    failWith('ENOSPC', 2);
    failWith('ENOSPC', 3);
    failWith('EIO', 4);
    failWith('ENOSPC', 5);
    failWith('EIO', 6);

    expect(warn.mock.calls).toEqual([
      ['[parley] feed image', 'ENOSPC'],
      ['[parley] feed image', 'EIO'],
    ]);
    expect(readdirSync(dir)).toEqual([]);
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

  it('каталог не читается (нет прав): исключения нет, одна строка с кодом, повтор того же кода молчит', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createFeedImageStore({ dir });
    const denied = (): void => {
      disk.failNextReaddir = Object.assign(new Error('permission denied'), { code: 'EACCES' });
      expect(() => store.sweep()).not.toThrow();
    };

    denied();
    denied();

    expect(warn.mock.calls).toEqual([['[parley] feed image', 'EACCES']]);
  });

  it('каталога нет — тихо: ничего не создаётся, ничего не выводится, исключения нет', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => createFeedImageStore({ dir }).sweep()).not.toThrow();

    expect(existsSync(dir)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});
