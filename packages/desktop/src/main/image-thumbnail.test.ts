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

/**
 * Картинка-пустышка. `toDataURL` называет её размер (`data:image/png;base64,320x200`), поэтому по ответу
 * `imageThumbnail` видно, во что картинку превратили. `resize` ведёт себя как в Electron: названа одна сторона —
 * вторая считается по пропорциям.
 */
function fakeImage(size = { width: 100, height: 100 }, label?: string): ThumbnailImage & { resizes: unknown[] } {
  const resizes: unknown[] = [];
  const image: ThumbnailImage & { resizes: unknown[] } = {
    resizes,
    isEmpty: () => size.width === 0,
    getSize: () => size,
    resize: (options) => {
      resizes.push(options);
      return fakeImage({
        width: options.width ?? Math.round((size.width * (options.height ?? size.height)) / size.height),
        height: options.height ?? Math.round((size.height * (options.width ?? size.width)) / size.width),
      });
    },
    toDataURL: () => `data:image/png;base64,${label ?? `${size.width}x${size.height}`}`,
  };
  return image;
}

const EMPTY = { width: 0, height: 0 };

function deps(patch: Partial<ThumbnailDeps> = {}): ThumbnailDeps & {
  createThumbnailFromPath: ReturnType<typeof vi.fn>;
  createFromPath: ReturnType<typeof vi.fn>;
} {
  return {
    // Системная миниатюра квадратного ящика растягивает в него картинку: для читаемых картинок её не просят.
    createThumbnailFromPath: vi.fn().mockResolvedValue(fakeImage({ width: 320, height: 320 }, 'system')),
    createFromPath: vi.fn().mockReturnValue(fakeImage({ width: 100, height: 100 }, 'read')),
    ...patch,
  } as ThumbnailDeps & { createThumbnailFromPath: ReturnType<typeof vi.fn>; createFromPath: ReturnType<typeof vi.fn> };
}

async function file(name: string, content: string | Buffer = 'x'): Promise<string> {
  const target = path.join(dir, name);
  await writeFile(target, content);
  return target;
}

// Заголовки GIF и WebP, как их пишут кодировщики (проверено на файлах `sips` и `cwebp`): тесту нужны только они.
function gifHeader(width: number, height: number): Buffer {
  const head = Buffer.alloc(13);
  head.write('GIF89a', 0, 'ascii');
  head.writeUInt16LE(width, 6);
  head.writeUInt16LE(height, 8);
  return head;
}

type WebpKind = 'lossy' | 'lossless' | 'extended';

function webpHeader(kind: WebpKind, width: number, height: number): Buffer {
  const head = Buffer.alloc(32);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(head.length - 8, 4);
  head.write('WEBP', 8, 'ascii');
  if (kind === 'lossy') {
    head.write('VP8 ', 12, 'ascii');
    head.set([0x10, 0x45, 0x00, 0x9d, 0x01, 0x2a], 20);
    head.writeUInt16LE(width, 26);
    head.writeUInt16LE(height, 28);
  } else if (kind === 'lossless') {
    head.write('VP8L', 12, 'ascii');
    head[20] = 0x2f;
    head.writeUInt32LE(((width - 1) | ((height - 1) << 14)) >>> 0, 21);
  } else {
    head.write('VP8X', 12, 'ascii');
    head.writeUIntLE(width - 1, 24, 3);
    head.writeUIntLE(height - 1, 27, 3);
  }
  return head;
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
    expect(d.createFromPath).not.toHaveBeenCalled();
  });

  it('файла нет — null', async () => {
    const d = deps();
    expect(await imageThumbnail(path.join(dir, 'gone.png'), d)).toBeNull();
    expect(d.createThumbnailFromPath).not.toHaveBeenCalled();
    expect(d.createFromPath).not.toHaveBeenCalled();
  });

  it('не обычный файл (каталог с именем картинки) — null', async () => {
    const d = deps();
    const folder = path.join(dir, 'folder.png');
    await mkdir(folder);
    expect(await imageThumbnail(folder, d)).toBeNull();
    expect(d.createThumbnailFromPath).not.toHaveBeenCalled();
    expect(d.createFromPath).not.toHaveBeenCalled();
  });

  it('путь с NUL — null, а не исключение', async () => {
    expect(await imageThumbnail(`${dir}/a\0.png`, deps())).toBeNull();
  });

  it('больше 20 МБ — null, ровно 20 МБ — читается', async () => {
    const d = deps();
    const big = await file('big.png');
    await truncate(big, MAX_DROP_IMAGE_BYTES + 1);
    expect(await imageThumbnail(big, d)).toBeNull();
    expect(d.createFromPath).not.toHaveBeenCalled();

    const edge = await file('edge.png');
    await truncate(edge, MAX_DROP_IMAGE_BYTES);
    expect(await imageThumbnail(edge, d)).toBe('data:image/png;base64,read');
  });
});

describe('imageThumbnail — миниатюра', () => {
  it('картинку, которую Electron читает сам (PNG, JPEG), читаем сами и уменьшаем; системную миниатюру не просим', async () => {
    const d = deps();
    const png = await file('a b.PNG');
    expect(await imageThumbnail(png, d)).toBe('data:image/png;base64,read');
    expect(d.createFromPath).toHaveBeenCalledWith(png);
    expect(d.createThumbnailFromPath).not.toHaveBeenCalled();
  });

  it('ссылка на картинку читается как сама картинка', async () => {
    const real = await file('real.png');
    const link = path.join(dir, 'link.jpg');
    await symlink(real, link);
    expect(await imageThumbnail(link, deps())).toBe('data:image/png;base64,read');
  });

  it('мелкая картинка не растягивается', async () => {
    const png = await file('small.png');
    const d = deps();
    const small = fakeImage({ width: 64, height: 48 });
    d.createFromPath.mockReturnValue(small);
    expect(await imageThumbnail(png, d)).toBe('data:image/png;base64,64x48');
    expect(small.resizes).toEqual([]);
  });

  it('картинка не прочиталась (пустая и не GIF/WebP) или чтение упало — null', async () => {
    const png = await file('broken.jpeg', 'not an image');
    const empty = deps();
    empty.createFromPath.mockReturnValue(fakeImage(EMPTY));
    expect(await imageThumbnail(png, empty)).toBeNull();

    const throwing = deps();
    throwing.createFromPath.mockImplementation(() => {
      throw new Error('decode failed');
    });
    expect(await imageThumbnail(png, throwing)).toBeNull();
    expect(throwing.createThumbnailFromPath).not.toHaveBeenCalled();
  });
});

describe('imageThumbnail — пропорции (macOS отдавал квадрат с картинкой, растянутой в него)', () => {
  it('широкий скриншот 1280×800: по умолчанию 320×200, на 1600 — как есть, вверх не растягивается', async () => {
    const png = await file('wide.png');
    const d = deps();
    d.createFromPath.mockImplementation(() => fakeImage({ width: 1280, height: 800 }));

    expect(await imageThumbnail(png, d)).toBe('data:image/png;base64,320x200');
    expect(await imageThumbnail(png, d, 1600)).toBe('data:image/png;base64,1280x800');
    expect(d.createThumbnailFromPath).not.toHaveBeenCalled();
  });

  it('исходник больше запрошенной стороны: 3200×2000 → 320×200 по умолчанию и 1600×1000 на 1600', async () => {
    const png = await file('huge.png');
    const d = deps();
    d.createFromPath.mockImplementation(() => fakeImage({ width: 3200, height: 2000 }));

    expect(await imageThumbnail(png, d)).toBe('data:image/png;base64,320x200');
    expect(await imageThumbnail(png, d, 1600)).toBe('data:image/png;base64,1600x1000');
  });

  it('высокая 400×800 уменьшается по высоте (длинной стороне): 160×320; квадрат 512×512 остаётся квадратом', async () => {
    const png = await file('tall.png');
    const d = deps();
    const tall = fakeImage({ width: 400, height: 800 });
    d.createFromPath.mockReturnValueOnce(tall);
    expect(await imageThumbnail(png, d)).toBe('data:image/png;base64,160x320');
    expect(tall.resizes).toEqual([{ height: 320 }]);

    d.createFromPath.mockReturnValueOnce(fakeImage({ width: 512, height: 512 }));
    expect(await imageThumbnail(png, d)).toBe('data:image/png;base64,320x320');
  });

  it('уменьшение называет только длинную сторону: короткую Electron считает сам, пропорции не ломаются', async () => {
    const png = await file('both.jpg');
    const d = deps();
    const wide = fakeImage({ width: 1366, height: 768 });
    d.createFromPath.mockReturnValue(wide);
    await imageThumbnail(png, d);
    expect(wide.resizes).toEqual([{ width: 320 }]);
  });
});

describe('imageThumbnail — GIF и WebP (Electron их сам не читает: createFromPath пуст)', () => {
  /** Электрон не читает файл сам, зато пустую картинку на создание отдаёт без исключения. */
  function unreadable(): ReturnType<typeof deps> {
    const d = deps();
    d.createFromPath.mockImplementation(() => fakeImage(EMPTY));
    d.createThumbnailFromPath.mockImplementation(async (_file: string, box: { width: number; height: number }) =>
      fakeImage(box, `system-${box.width}x${box.height}`),
    );
    return d;
  }

  const SAMPLES: Array<[string, (width: number, height: number) => Buffer]> = [
    ['anim.gif', gifHeader],
    ['lossy.webp', (width, height) => webpHeader('lossy', width, height)],
    ['lossless.webp', (width, height) => webpHeader('lossless', width, height)],
    ['alpha.webp', (width, height) => webpHeader('extended', width, height)],
  ];

  it.each(SAMPLES)('%s: размер берётся из заголовка, системную миниатюру просят ящиком тех же пропорций', async (name, header) => {
    const d = unreadable();
    const wide = await file(name, header(1280, 800));
    expect(await imageThumbnail(wide, d)).toBe('data:image/png;base64,system-320x200');
    expect(d.createThumbnailFromPath).toHaveBeenLastCalledWith(wide, { width: 320, height: 200 });

    // На 1600 картинка 1280×800 остаётся своего размера: вверх не растягиваем и здесь.
    expect(await imageThumbnail(wide, d, 1600)).toBe('data:image/png;base64,system-1280x800');
    expect(d.createThumbnailFromPath).toHaveBeenLastCalledWith(wide, { width: 1280, height: 800 });

    const tall = await file(name, header(400, 800));
    await imageThumbnail(tall, d);
    expect(d.createThumbnailFromPath).toHaveBeenLastCalledWith(tall, { width: 160, height: 320 });

    // Больше стороны — ящик по длинной стороне; меньше — как есть.
    const big = await file(name, header(3200, 2000));
    await imageThumbnail(big, d, 1600);
    expect(d.createThumbnailFromPath).toHaveBeenLastCalledWith(big, { width: 1600, height: 1000 });
    const small = await file(name, header(40, 30));
    await imageThumbnail(small, d);
    expect(d.createThumbnailFromPath).toHaveBeenLastCalledWith(small, { width: 40, height: 30 });
  });

  it('WebP шириной и высотой до 16384 px (14 бит в VP8, 24 бита в VP8X) читается без искажений', async () => {
    const d = unreadable();
    const lossless = await file('max.webp', webpHeader('lossless', 16384, 100));
    await imageThumbnail(lossless, d);
    expect(d.createThumbnailFromPath).toHaveBeenLastCalledWith(lossless, { width: 320, height: 2 });
    const extended = await file('canvas.webp', webpHeader('extended', 30000, 15000));
    await imageThumbnail(extended, d);
    expect(d.createThumbnailFromPath).toHaveBeenLastCalledWith(extended, { width: 320, height: 160 });
    // VP8: старшие два бита слова ширины — масштаб кадра, а не часть размера.
    const scaled = await file('scaled.webp', webpHeader('lossy', 1280 | 0xc000, 800));
    await imageThumbnail(scaled, d);
    expect(d.createThumbnailFromPath).toHaveBeenLastCalledWith(scaled, { width: 320, height: 200 });
  });

  it('заголовок не разобрать (мусор, обрезан, нулевой размер, чужой формат) — null, системную миниатюру не просят', async () => {
    const d = unreadable();
    const truncated = webpHeader('lossy', 1280, 800).subarray(0, 24);
    const riffOfSomethingElse = webpHeader('lossy', 1280, 800);
    riffOfSomethingElse.write('AVI ', 8, 'ascii');
    const unknownChunk = webpHeader('lossy', 1280, 800);
    unknownChunk.write('JUNK', 12, 'ascii');
    const badStartCode = webpHeader('lossy', 1280, 800);
    badStartCode[24] = 0;
    const bad: Array<[string, Buffer | string]> = [
      ['empty.gif', ''],
      ['text.gif', 'this is not a gif'],
      ['short.gif', gifHeader(1280, 800).subarray(0, 9)],
      ['zero.gif', gifHeader(0, 800)],
      ['truncated.webp', truncated],
      ['riff.webp', riffOfSomethingElse],
      ['chunk.webp', unknownChunk],
      ['start-code.webp', badStartCode],
      ['zero.webp', webpHeader('lossy', 0, 800)],
      ['png-as.gif', Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')],
    ];
    for (const [name, content] of bad) {
      expect(await imageThumbnail(await file(name, content), d), name).toBeNull();
    }
    expect(d.createThumbnailFromPath).not.toHaveBeenCalled();
  });

  it('системной миниатюры нет (Linux: функции нет), она отказала или вернула пустую — null, а не исключение', async () => {
    const wide = await file('wide.gif', gifHeader(1280, 800));

    const missing = deps({ createThumbnailFromPath: undefined as never });
    missing.createFromPath.mockReturnValue(fakeImage(EMPTY));
    expect(await imageThumbnail(wide, missing)).toBeNull();

    const rejected = deps({ createThumbnailFromPath: vi.fn().mockRejectedValue(new Error('no thumbnail')) });
    rejected.createFromPath.mockReturnValue(fakeImage(EMPTY));
    expect(await imageThumbnail(wide, rejected)).toBeNull();

    const empty = deps({ createThumbnailFromPath: vi.fn().mockResolvedValue(fakeImage(EMPTY)) });
    empty.createFromPath.mockReturnValue(fakeImage(EMPTY));
    expect(await imageThumbnail(wide, empty)).toBeNull();
  });

  it('PNG, который Electron не прочёл, GIF/WebP-путь не подхватывает: заголовок чужой — null', async () => {
    const d = unreadable();
    expect(await imageThumbnail(await file('odd.png', 'junk'), d)).toBeNull();
    expect(d.createThumbnailFromPath).not.toHaveBeenCalled();
  });
});

describe('imageThumbnail — размер по запросу (просмотр картинки из результата инструмента просит 1600)', () => {
  it('сторона — длинная: 5000×3000 на 64 → 64×38, по умолчанию 320×192, на 1600 → 1600×960, на 2048 → 2048×1229', async () => {
    const png = await file('shot.png');
    const d = deps();
    d.createFromPath.mockImplementation(() => fakeImage({ width: 5000, height: 3000 }));
    const sizes: string[] = [];
    for (const side of [64, undefined, 1600, 2048]) sizes.push((await imageThumbnail(png, d, side)) ?? '');
    expect(sizes.map((url) => url.split(',')[1])).toEqual(['64x38', '320x192', '1600x960', '2048x1229']);
  });

  it('чужое значение (окну не доверяем) — 320: 99999, за границами, дробное, NaN, не число', async () => {
    const png = await file('bad.png');
    const d = deps();
    d.createFromPath.mockImplementation(() => fakeImage({ width: 5000, height: 3000 }));
    const bad = [99999, 2049, 63, 0, -1, 320.5, Number.NaN, Number.POSITIVE_INFINITY, '1600', null, {}, [1600], true];
    for (const value of bad) expect(await imageThumbnail(png, d, value), String(value)).toBe('data:image/png;base64,320x192');
  });

  it('GIF/WebP: запрошенная сторона тоже проверяется — чужое значение читается как 320', async () => {
    const wide = await file('wide.webp', webpHeader('lossy', 5000, 3000));
    const d = deps();
    d.createFromPath.mockReturnValue(fakeImage(EMPTY));
    for (const value of [99999, 63, 320.5, Number.NaN, '1600', {}]) await imageThumbnail(wide, d, value);
    for (const call of d.createThumbnailFromPath.mock.calls) expect(call[1]).toEqual({ width: 320, height: 192 });
    expect(d.createThumbnailFromPath).toHaveBeenCalledTimes(6);
  });

  it('предел файла прежний и при большом размере: 20 МБ + 1 байт — null, расширение не из списка — null', async () => {
    const d = deps();
    const big = await file('huge.png');
    await truncate(big, MAX_DROP_IMAGE_BYTES + 1);
    expect(await imageThumbnail(big, d, 2048)).toBeNull();
    expect(await imageThumbnail(await file('notes.txt'), d, 2048)).toBeNull();
    expect(d.createFromPath).not.toHaveBeenCalled();
    expect(d.createThumbnailFromPath).not.toHaveBeenCalled();
  });
});
