import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_DROP_IMAGE_BYTES } from './drops.js';
import { imageThumbnail, type ThumbnailDeps, type ThumbnailImage } from './image-thumbnail.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'hh-thumb-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Картинка-пустышка: `resize` записывает, во что её просили превратить, и отдаёт уменьшенную копию. */
function fakeImage(url: string, size = { width: 100, height: 100 }): ThumbnailImage & { resizes: unknown[] } {
  const resizes: unknown[] = [];
  const image: ThumbnailImage & { resizes: unknown[] } = {
    resizes,
    isEmpty: () => size.width === 0,
    getSize: () => size,
    resize: (options) => {
      resizes.push(options);
      return fakeImage(`${url}-resized`, { width: options.width ?? 1, height: options.height ?? 1 });
    },
    toDataURL: () => `data:image/png;base64,${url}`,
  };
  return image;
}

function deps(patch: Partial<ThumbnailDeps> = {}): ThumbnailDeps & {
  createThumbnailFromPath: ReturnType<typeof vi.fn>;
  createFromPath: ReturnType<typeof vi.fn>;
} {
  return {
    createThumbnailFromPath: vi.fn().mockResolvedValue(fakeImage('thumb')),
    createFromPath: vi.fn().mockReturnValue(fakeImage('read')),
    ...patch,
  } as ThumbnailDeps & { createThumbnailFromPath: ReturnType<typeof vi.fn>; createFromPath: ReturnType<typeof vi.fn> };
}

async function file(name: string, content: string | Buffer = 'x'): Promise<string> {
  const target = path.join(dir, name);
  await writeFile(target, content);
  return target;
}

describe('imageThumbnail — отказы без чтения картинки', () => {
  it('не строка и не абсолютный путь — null', async () => {
    const d = deps();
    for (const input of [undefined, null, 42, {}, ['/a.png'], '', 'a.png', './a.png', '../a.png', '~/a.png']) {
      expect(await imageThumbnail(input, d), String(input)).toBeNull();
    }
    expect(d.createThumbnailFromPath).not.toHaveBeenCalled();
    expect(d.createFromPath).not.toHaveBeenCalled();
  });

  it('расширение не из списка картинок — null, хотя файл есть', async () => {
    const d = deps();
    expect(await imageThumbnail(await file('notes.txt'), d)).toBeNull();
    expect(await imageThumbnail(await file('doc.pdf'), d)).toBeNull();
    expect(await imageThumbnail(await file('logo.svg'), d)).toBeNull();
    expect(d.createThumbnailFromPath).not.toHaveBeenCalled();
  });

  it('файла нет — null', async () => {
    const d = deps();
    expect(await imageThumbnail(path.join(dir, 'gone.png'), d)).toBeNull();
    expect(d.createThumbnailFromPath).not.toHaveBeenCalled();
  });

  it('не обычный файл (каталог с именем картинки) — null', async () => {
    const d = deps();
    const folder = path.join(dir, 'folder.png');
    await mkdir(folder);
    expect(await imageThumbnail(folder, d)).toBeNull();
    expect(d.createThumbnailFromPath).not.toHaveBeenCalled();
  });

  it('путь с NUL — null, а не исключение', async () => {
    expect(await imageThumbnail(`${dir}/a\0.png`, deps())).toBeNull();
  });

  it('больше 20 МБ — null, ровно 20 МБ — читается', async () => {
    const d = deps();
    const big = await file('big.png');
    await truncate(big, MAX_DROP_IMAGE_BYTES + 1);
    expect(await imageThumbnail(big, d)).toBeNull();
    expect(d.createThumbnailFromPath).not.toHaveBeenCalled();

    const edge = await file('edge.png');
    await truncate(edge, MAX_DROP_IMAGE_BYTES);
    expect(await imageThumbnail(edge, d)).toBe('data:image/png;base64,thumb');
  });
});

describe('imageThumbnail — миниатюра', () => {
  it('системная миниатюра 320×320 → её data-URL; своё чтение не нужно', async () => {
    const d = deps();
    const png = await file('a b.PNG');
    expect(await imageThumbnail(png, d)).toBe('data:image/png;base64,thumb');
    expect(d.createThumbnailFromPath).toHaveBeenCalledWith(png, { width: 320, height: 320 });
    expect(d.createFromPath).not.toHaveBeenCalled();
  });

  it('ссылка на картинку читается как сама картинка', async () => {
    const real = await file('real.png');
    const link = path.join(dir, 'link.jpg');
    await symlink(real, link);
    expect(await imageThumbnail(link, deps())).toBe('data:image/png;base64,thumb');
  });

  it('системная миниатюра отказала (исключение или нет функции) — читаем сами и уменьшаем по длинной стороне', async () => {
    const png = await file('wide.png');
    const rejected = deps({ createThumbnailFromPath: vi.fn().mockRejectedValue(new Error('no thumbnail')) });
    rejected.createFromPath.mockReturnValue(fakeImage('wide', { width: 1000, height: 500 }));
    expect(await imageThumbnail(png, rejected)).toBe('data:image/png;base64,wide-resized');
    expect(rejected.createFromPath).toHaveBeenCalledWith(png);

    const missing = deps({ createThumbnailFromPath: undefined as never });
    const tall = fakeImage('tall', { width: 500, height: 1000 });
    missing.createFromPath.mockReturnValue(tall);
    expect(await imageThumbnail(png, missing)).toBe('data:image/png;base64,tall-resized');
    expect(tall.resizes).toEqual([{ height: 320 }]);
  });

  it('системная миниатюра пустая — тоже читаем сами; широкая уменьшается по ширине', async () => {
    const png = await file('empty-thumb.png');
    const d = deps({ createThumbnailFromPath: vi.fn().mockResolvedValue(fakeImage('none', { width: 0, height: 0 })) });
    const wide = fakeImage('wide', { width: 640, height: 480 });
    d.createFromPath.mockReturnValue(wide);
    expect(await imageThumbnail(png, d)).toBe('data:image/png;base64,wide-resized');
    expect(wide.resizes).toEqual([{ width: 320 }]);
  });

  it('мелкая картинка не растягивается', async () => {
    const png = await file('small.gif');
    const d = deps({ createThumbnailFromPath: vi.fn().mockRejectedValue(new Error('no')) });
    const small = fakeImage('small', { width: 64, height: 48 });
    d.createFromPath.mockReturnValue(small);
    expect(await imageThumbnail(png, d)).toBe('data:image/png;base64,small');
    expect(small.resizes).toEqual([]);
  });

  it('картинка не прочиталась (пустая) или чтение упало — null', async () => {
    const png = await file('broken.webp');
    const empty = deps({ createThumbnailFromPath: vi.fn().mockRejectedValue(new Error('no')) });
    empty.createFromPath.mockReturnValue(fakeImage('x', { width: 0, height: 0 }));
    expect(await imageThumbnail(png, empty)).toBeNull();

    const throwing = deps({ createThumbnailFromPath: vi.fn().mockRejectedValue(new Error('no')) });
    throwing.createFromPath.mockImplementation(() => {
      throw new Error('decode failed');
    });
    expect(await imageThumbnail(png, throwing)).toBeNull();
  });
});

describe('imageThumbnail — размер по запросу (просмотр картинки из результата инструмента просит 1600)', () => {
  it('1600 → системная миниатюра просится на 1600×1600; без размера — прежние 320', async () => {
    const png = await file('shot.png');
    const sized = deps();
    expect(await imageThumbnail(png, sized, 1600)).toBe('data:image/png;base64,thumb');
    expect(sized.createThumbnailFromPath).toHaveBeenCalledWith(png, { width: 1600, height: 1600 });

    const plain = deps();
    await imageThumbnail(png, plain);
    await imageThumbnail(png, plain, undefined);
    expect(plain.createThumbnailFromPath.mock.calls.map((call) => call[1])).toEqual([
      { width: 320, height: 320 },
      { width: 320, height: 320 },
    ]);
  });

  it('границы 64 и 2048 принимаются как есть', async () => {
    const png = await file('edge.png');
    const d = deps();
    await imageThumbnail(png, d, 64);
    await imageThumbnail(png, d, 2048);
    expect(d.createThumbnailFromPath.mock.calls.map((call) => call[1])).toEqual([
      { width: 64, height: 64 },
      { width: 2048, height: 2048 },
    ]);
  });

  it('чужое значение (окну не доверяем) — 320: 99999, за границами, дробное, NaN, не число', async () => {
    const png = await file('bad.png');
    const d = deps();
    const bad = [99999, 2049, 63, 0, -1, 320.5, Number.NaN, Number.POSITIVE_INFINITY, '1600', null, {}, [1600], true];
    for (const value of bad) await imageThumbnail(png, d, value);
    expect(d.createThumbnailFromPath).toHaveBeenCalledTimes(bad.length);
    for (const call of d.createThumbnailFromPath.mock.calls) expect(call[1]).toEqual({ width: 320, height: 320 });
  });

  it('системных миниатюр нет — читаем сами и уменьшаем до запрошенной стороны, а не до 320', async () => {
    const png = await file('wide.png');
    const d = deps({ createThumbnailFromPath: vi.fn().mockRejectedValue(new Error('no thumbnail')) });
    const wide = fakeImage('wide', { width: 3000, height: 2000 });
    d.createFromPath.mockReturnValue(wide);
    expect(await imageThumbnail(png, d, 1600)).toBe('data:image/png;base64,wide-resized');
    expect(wide.resizes).toEqual([{ width: 1600 }]);

    // Картинка меньше запрошенной стороны не растягивается, хотя на 320 её уменьшили бы.
    const small = fakeImage('small', { width: 1000, height: 500 });
    d.createFromPath.mockReturnValue(small);
    expect(await imageThumbnail(png, d, 1600)).toBe('data:image/png;base64,small');
    expect(small.resizes).toEqual([]);
    expect(await imageThumbnail(png, d)).toBe('data:image/png;base64,small-resized');
    expect(small.resizes).toEqual([{ width: 320 }]);
  });

  it('предел файла прежний и при большом размере: 20 МБ + 1 байт — null, расширение не из списка — null', async () => {
    const d = deps();
    const big = await file('huge.png');
    await truncate(big, MAX_DROP_IMAGE_BYTES + 1);
    expect(await imageThumbnail(big, d, 2048)).toBeNull();
    expect(await imageThumbnail(await file('notes.txt'), d, 2048)).toBeNull();
    expect(d.createThumbnailFromPath).not.toHaveBeenCalled();
  });
});
