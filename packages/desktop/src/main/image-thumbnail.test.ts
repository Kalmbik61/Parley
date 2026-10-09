import { mkdir, mkdtemp, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises';
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
    // Системная миниатюра квадратного ящика растягивает в него картинку: для PNG и JPEG её не просят.
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

// Заголовки форматов, как их пишут кодировщики (проверено на файлах `sips`, `cwebp` и настоящем E2E): тесту нужны
// только они — сами пиксели никто не декодирует, `nativeImage` подставной.
function pngHeader(width: number, height: number): Buffer {
  const head = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write('IHDR', 12, 'latin1');
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  head.set([8, 2], 24); // 8 бит, RGB
  return head;
}

interface JpegOptions {
  /** Сколько байт занять сегментами APP2 (профиль цвета) до кадра. */
  padding?: number;
  /** Сколько байт-заполнителей `FF` поставить перед маркером кадра. */
  fill?: number;
  progressive?: boolean;
  /** Положить в EXIF (APP1) встроенную миниатюру с таким кадром — со своим SOI. */
  embedded?: { width: number; height: number };
}

function jpegHeader(width: number, height: number, options: JpegOptions = {}): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  if (options.embedded !== undefined) {
    const inner = jpegHeader(options.embedded.width, options.embedded.height);
    const app1 = Buffer.alloc(4 + inner.length);
    app1.set([0xff, 0xe1], 0);
    app1.writeUInt16BE(inner.length + 2, 2);
    inner.copy(app1, 4);
    parts.push(app1);
  }
  let rest = options.padding ?? 0;
  while (rest > 0) {
    const body = Math.min(rest, 65533);
    const app2 = Buffer.alloc(4 + body, 0x41);
    app2.set([0xff, 0xe2], 0);
    app2.writeUInt16BE(body + 2, 2);
    parts.push(app2);
    rest -= body;
  }
  if ((options.fill ?? 0) > 0) parts.push(Buffer.alloc(options.fill ?? 0, 0xff));
  const frame = Buffer.alloc(19);
  frame.set([0xff, options.progressive === true ? 0xc2 : 0xc0], 0);
  frame.writeUInt16BE(17, 2);
  frame[4] = 8;
  frame.writeUInt16BE(height, 5);
  frame.writeUInt16BE(width, 7);
  frame[9] = 3;
  parts.push(frame);
  return Buffer.concat(parts);
}

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

  it('расширение не из списка картинок — null, хотя файл настоящая картинка', async () => {
    const d = deps();
    expect(await imageThumbnail(await file('notes.txt', pngHeader(10, 10)), d)).toBeNull();
    expect(await imageThumbnail(await file('doc.pdf', pngHeader(10, 10)), d)).toBeNull();
    expect(await imageThumbnail(await file('logo.svg', pngHeader(10, 10)), d)).toBeNull();
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
    const big = await file('big.png', pngHeader(1280, 800));
    await truncate(big, MAX_DROP_IMAGE_BYTES + 1);
    expect(await imageThumbnail(big, d)).toBeNull();
    expect(d.createFromPath).not.toHaveBeenCalled();

    const edge = await file('edge.png', pngHeader(1280, 800));
    await truncate(edge, MAX_DROP_IMAGE_BYTES);
    expect(await imageThumbnail(edge, d)).toBe('data:image/png;base64,read');
  });
});

describe('imageThumbnail — миниатюра', () => {
  it('PNG и JPEG, которые Electron читает сам, читаем сами и уменьшаем; системную миниатюру не просим', async () => {
    const d = deps();
    const png = await file('a b.PNG', pngHeader(1280, 800));
    expect(await imageThumbnail(png, d)).toBe('data:image/png;base64,read');
    expect(d.createFromPath).toHaveBeenLastCalledWith(png);

    const jpeg = await file('photo.jpeg', jpegHeader(1280, 800));
    expect(await imageThumbnail(jpeg, d)).toBe('data:image/png;base64,read');
    expect(d.createFromPath).toHaveBeenLastCalledWith(jpeg);
    expect(d.createThumbnailFromPath).not.toHaveBeenCalled();
  });

  it('ссылка на картинку читается как сама картинка', async () => {
    const real = await file('real.png', pngHeader(100, 100));
    const link = path.join(dir, 'link.jpg');
    await symlink(real, link);
    expect(await imageThumbnail(link, deps())).toBe('data:image/png;base64,read');
  });

  it('мелкая картинка не растягивается', async () => {
    const png = await file('small.png', pngHeader(64, 48));
    const d = deps();
    const small = fakeImage({ width: 64, height: 48 });
    d.createFromPath.mockReturnValue(small);
    expect(await imageThumbnail(png, d)).toBe('data:image/png;base64,64x48');
    expect(small.resizes).toEqual([]);
  });

  it('Electron не смог декодировать (пустая картинка) или чтение упало — null: у PNG и JPEG системной миниатюры нет', async () => {
    const png = await file('broken.jpeg', pngHeader(640, 480));
    const empty = deps();
    empty.createFromPath.mockReturnValue(fakeImage(EMPTY));
    expect(await imageThumbnail(png, empty)).toBeNull();
    expect(empty.createThumbnailFromPath).not.toHaveBeenCalled();

    const throwing = deps();
    throwing.createFromPath.mockImplementation(() => {
      throw new Error('decode failed');
    });
    expect(await imageThumbnail(png, throwing)).toBeNull();
    expect(throwing.createThumbnailFromPath).not.toHaveBeenCalled();
  });

  it('не картинка по содержимому (текст, SVG, обрезанная подпись) под именем картинки — null, к Electron никто не обращался', async () => {
    const d = deps();
    const contents: Array<[string, Buffer | string]> = [
      ['text.png', 'not an image at all'],
      ['svg.png', '<svg xmlns="http://www.w3.org/2000/svg"/>'],
      ['half.png', pngHeader(10, 10).subarray(0, 12)],
      ['bare.jpg', Buffer.from([0xff, 0xd8])],
      ['empty.gif', ''],
    ];
    for (const [name, content] of contents) {
      expect(await imageThumbnail(await file(name, content), d), name).toBeNull();
    }
    expect(d.createFromPath).not.toHaveBeenCalled();
    expect(d.createThumbnailFromPath).not.toHaveBeenCalled();
  });

  it('формат — по заголовку, а не по расширению: WebP под именем .png уходит системе, PNG под именем .gif декодируется сам', async () => {
    const d = deps();
    d.createThumbnailFromPath.mockImplementation(async (_file: string, box: { width: number; height: number }) =>
      fakeImage(box, `system-${box.width}x${box.height}`),
    );

    expect(await imageThumbnail(await file('really-webp.png', webpHeader('lossy', 1280, 800)), d)).toBe('data:image/png;base64,system-320x200');
    expect(d.createFromPath).not.toHaveBeenCalled();

    expect(await imageThumbnail(await file('really-png.gif', pngHeader(1280, 800)), d)).toBe('data:image/png;base64,read');
    expect(d.createFromPath).toHaveBeenCalledTimes(1);
  });
});

describe('imageThumbnail — пропорции (macOS отдавал квадрат с картинкой, растянутой в него)', () => {
  it('широкий скриншот 1280×800: по умолчанию 320×200, на 1600 — как есть, вверх не растягивается', async () => {
    const png = await file('wide.png', pngHeader(1280, 800));
    const d = deps();
    d.createFromPath.mockImplementation(() => fakeImage({ width: 1280, height: 800 }));

    expect(await imageThumbnail(png, d)).toBe('data:image/png;base64,320x200');
    expect(await imageThumbnail(png, d, 1600)).toBe('data:image/png;base64,1280x800');
    expect(d.createThumbnailFromPath).not.toHaveBeenCalled();
  });

  it('исходник больше запрошенной стороны: 3200×2000 → 320×200 по умолчанию и 1600×1000 на 1600', async () => {
    const png = await file('huge.png', pngHeader(3200, 2000));
    const d = deps();
    d.createFromPath.mockImplementation(() => fakeImage({ width: 3200, height: 2000 }));

    expect(await imageThumbnail(png, d)).toBe('data:image/png;base64,320x200');
    expect(await imageThumbnail(png, d, 1600)).toBe('data:image/png;base64,1600x1000');
  });

  it('высокая 400×800 уменьшается по высоте (длинной стороне): 160×320; квадрат 512×512 остаётся квадратом', async () => {
    const png = await file('tall.png', pngHeader(400, 800));
    const d = deps();
    const tall = fakeImage({ width: 400, height: 800 });
    d.createFromPath.mockReturnValueOnce(tall);
    expect(await imageThumbnail(png, d)).toBe('data:image/png;base64,160x320');
    expect(tall.resizes).toEqual([{ height: 320 }]);

    d.createFromPath.mockReturnValueOnce(fakeImage({ width: 512, height: 512 }));
    expect(await imageThumbnail(png, d)).toBe('data:image/png;base64,320x320');
  });

  it('уменьшение называет только длинную сторону: короткую Electron считает сам, пропорции не ломаются', async () => {
    const png = await file('both.jpg', jpegHeader(1366, 768));
    const d = deps();
    const wide = fakeImage({ width: 1366, height: 768 });
    d.createFromPath.mockReturnValue(wide);
    await imageThumbnail(png, d);
    expect(wide.resizes).toEqual([{ width: 320 }]);
  });
});

describe('imageThumbnail — GIF и WebP (Electron их сам не читает)', () => {
  /** Системная миниатюра отдаёт ящик, который ей назвали; Electron GIF и WebP сам не декодирует и не вызывается. */
  function system(): ReturnType<typeof deps> {
    const d = deps();
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
    const d = system();
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

    // Electron GIF и WebP не читает: его декодер ни разу не звали.
    expect(d.createFromPath).not.toHaveBeenCalled();
  });

  it('WebP шириной и высотой до 16384 px (14 бит в VP8, 24 бита в VP8X) читается без искажений', async () => {
    const d = system();
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
    const d = system();
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
    ];
    for (const [name, content] of bad) {
      expect(await imageThumbnail(await file(name, content), d), name).toBeNull();
    }
    expect(d.createThumbnailFromPath).not.toHaveBeenCalled();
  });

  it('системной миниатюры нет (Linux: функции нет), она отказала или вернула пустую — null, а не исключение', async () => {
    const wide = await file('wide.gif', gifHeader(1280, 800));

    const missing = deps({ createThumbnailFromPath: undefined as never });
    expect(await imageThumbnail(wide, missing)).toBeNull();

    const rejected = deps({ createThumbnailFromPath: vi.fn().mockRejectedValue(new Error('no thumbnail')) });
    expect(await imageThumbnail(wide, rejected)).toBeNull();

    const empty = deps({ createThumbnailFromPath: vi.fn().mockResolvedValue(fakeImage(EMPTY)) });
    expect(await imageThumbnail(wide, empty)).toBeNull();
  });

  it('предел пикселей для декодирования в main их не касается: систему вне процесса просят ящиком по стороне, как обычно', async () => {
    const d = system();
    const wide = await file('panorama.gif', gifHeader(20000, 20000));

    expect(await imageThumbnail(wide, d)).toBe('data:image/png;base64,system-320x320');
    expect(d.createFromPath).not.toHaveBeenCalled();
  });
});

describe('imageThumbnail — размер по запросу (просмотр картинки из результата инструмента просит 1600)', () => {
  it('сторона — длинная: 5000×3000 на 64 → 64×38, по умолчанию 320×192, на 1600 → 1600×960, на 2048 → 2048×1229', async () => {
    const png = await file('shot.png', pngHeader(5000, 3000));
    const d = deps();
    d.createFromPath.mockImplementation(() => fakeImage({ width: 5000, height: 3000 }));
    const sizes: string[] = [];
    for (const side of [64, undefined, 1600, 2048]) sizes.push((await imageThumbnail(png, d, side)) ?? '');
    expect(sizes.map((url) => url.split(',')[1])).toEqual(['64x38', '320x192', '1600x960', '2048x1229']);
  });

  it('чужое значение (окну не доверяем) — 320: 99999, за границами, дробное, NaN, не число', async () => {
    const png = await file('bad.png', pngHeader(5000, 3000));
    const d = deps();
    d.createFromPath.mockImplementation(() => fakeImage({ width: 5000, height: 3000 }));
    const bad = [99999, 2049, 63, 0, -1, 320.5, Number.NaN, Number.POSITIVE_INFINITY, '1600', null, {}, [1600], true];
    for (const value of bad) expect(await imageThumbnail(png, d, value), String(value)).toBe('data:image/png;base64,320x192');
  });

  it('GIF/WebP: запрошенная сторона тоже проверяется — чужое значение читается как 320', async () => {
    const wide = await file('wide.webp', webpHeader('lossy', 5000, 3000));
    const d = deps();
    for (const value of [99999, 63, 320.5, Number.NaN, '1600', {}]) await imageThumbnail(wide, d, value);
    for (const call of d.createThumbnailFromPath.mock.calls) expect(call[1]).toEqual({ width: 320, height: 192 });
    expect(d.createThumbnailFromPath).toHaveBeenCalledTimes(6);
  });

  it('предел файла прежний и при большом размере: 20 МБ + 1 байт — null, расширение не из списка — null', async () => {
    const d = deps();
    const big = await file('huge.png', pngHeader(1280, 800));
    await truncate(big, MAX_DROP_IMAGE_BYTES + 1);
    expect(await imageThumbnail(big, d, 2048)).toBeNull();
    expect(await imageThumbnail(await file('notes.txt', pngHeader(10, 10)), d, 2048)).toBeNull();
    expect(d.createFromPath).not.toHaveBeenCalled();
    expect(d.createThumbnailFromPath).not.toHaveBeenCalled();
  });
});

describe('imageThumbnail — бомба: крошечный файл с огромным размером в заголовке не декодируется', () => {
  const crafted: Array<[string, () => Buffer]> = [
    ['PNG 20000×20000 (400 Мпикс)', () => pngHeader(20000, 20000)],
    ['PNG 60000×60000', () => pngHeader(60000, 60000)],
    ['PNG 16385×10 (сторона за пределом)', () => pngHeader(16385, 10)],
    ['PNG 10×16385', () => pngHeader(10, 16385)],
    ['JPEG 65535×65535', () => jpegHeader(65535, 65535)],
    ['JPEG 16385×100', () => jpegHeader(16385, 100)],
    ['JPEG 100×16385', () => jpegHeader(100, 16385)],
    ['JPEG 20000×20000 после 200 КБ профиля цвета', () => jpegHeader(20000, 20000, { padding: 200_000 })],
  ];

  it.each(crafted)('%s — null и на миниатюру, и на просмотр; декодер не звали', async (_title, make) => {
    const d = deps();
    const bomb = await file('bomb.png', make());
    // Мал: заголовок и немного сверху, а не картинка в сотни мегапикселей.
    expect((await stat(bomb)).size).toBeLessThan(300_000);

    expect(await imageThumbnail(bomb, d)).toBeNull();
    expect(await imageThumbnail(bomb, d, 1600)).toBeNull();
    expect(await imageThumbnail(bomb, d, 2048)).toBeNull();
    expect(d.createFromPath).not.toHaveBeenCalled();
    expect(d.createThumbnailFromPath).not.toHaveBeenCalled();
  });

  it('граница по числу пикселей: 50 000 000 ровно — читается, на пиксель-столбец больше — нет; сторона 16384 читается', async () => {
    const d = deps();
    const allowed: Array<[string, Buffer]> = [
      ['exact-png.png', pngHeader(8000, 6250)],
      ['exact-jpeg.jpg', jpegHeader(8000, 6250)],
      ['side-png.png', pngHeader(16384, 3000)],
      ['side-jpeg.jpg', jpegHeader(3000, 16384)],
    ];
    for (const [name, content] of allowed) {
      expect(await imageThumbnail(await file(name, content), d), name).toBe('data:image/png;base64,read');
    }
    expect(d.createFromPath).toHaveBeenCalledTimes(allowed.length);

    d.createFromPath.mockClear();
    for (const [name, content] of [
      ['over-png.png', pngHeader(8001, 6250)],
      ['over-jpeg.jpg', jpegHeader(7000, 7143)],
      ['wide-png.png', pngHeader(16385, 1)],
    ] as Array<[string, Buffer]>) {
      expect(await imageThumbnail(await file(name, content), d), name).toBeNull();
    }
    expect(d.createFromPath).not.toHaveBeenCalled();
  });

  it('размер из заголовка не прочесть — PNG и JPEG не декодируются: что нельзя проверить, не читается', async () => {
    const d = deps();
    const noIhdr = pngHeader(100, 100);
    noIhdr.write('IDAT', 12, 'latin1');
    const afterData = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xda, 0x00, 0x04, 0x00, 0x00]), jpegHeader(100, 100).subarray(2)]);
    const endedEarly = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const truncatedBeforeFrame = jpegHeader(100, 100).subarray(0, 8);
    const noLength = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0x01, 0x02]);
    const manySegments = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      ...Array.from({ length: 300 }, () => Buffer.from([0xff, 0xe0, 0x00, 0x02])),
      jpegHeader(100, 100).subarray(2),
    ]);
    const cases: Array<[string, Buffer]> = [
      ['PNG без IHDR первым блоком', noIhdr],
      ['PNG: IHDR обрезан', pngHeader(100, 100).subarray(0, 20)],
      ['PNG с нулевой шириной', pngHeader(0, 100)],
      ['JPEG: данные раньше кадра (SOS)', afterData],
      ['JPEG: конец изображения раньше кадра', endedEarly],
      ['JPEG обрезан до кадра', truncatedBeforeFrame],
      ['JPEG: сегмент с длиной меньше двух', noLength],
      ['JPEG: сегментов больше 256 до кадра', manySegments],
      ['JPEG с нулевой высотой', jpegHeader(100, 0)],
    ];
    for (const [name, content] of cases) {
      expect(await imageThumbnail(await file(`${name.replace(/\W+/g, '-')}.jpg`, content), d), name).toBeNull();
    }
    expect(d.createFromPath).not.toHaveBeenCalled();
  });

  describe('кадр JPEG ищется по сегментам', () => {
    it.each([
      ['после 200 КБ профиля цвета (три сегмента APP2)', { padding: 200_000 }],
      ['прогрессивный (SOF2)', { progressive: true }],
      ['после байтов-заполнителей FF перед маркером', { fill: 7 }],
    ] as Array<[string, JpegOptions]>)('кадр %s найден: большая картинка отвергнута, обычная декодируется', async (_title, options) => {
      const d = deps();
      const big = await file('big.jpg', jpegHeader(20000, 20000, options));
      const fine = await file('fine.jpg', jpegHeader(1920, 1080, options));

      expect(await imageThumbnail(big, d)).toBeNull();
      expect(d.createFromPath).not.toHaveBeenCalled();
      expect(await imageThumbnail(fine, d)).toBe('data:image/png;base64,read');
      expect(d.createFromPath).toHaveBeenCalledWith(fine);
    });

    it('встроенная в EXIF миниатюра маленькая, а кадр самой картинки огромный — отвергается: чужой кадр внутри сегмента не в счёт', async () => {
      const d = deps();
      const bomb = await file('exif-bomb.jpg', jpegHeader(30000, 30000, { embedded: { width: 160, height: 120 } }));

      expect(await imageThumbnail(bomb, d)).toBeNull();
      expect(d.createFromPath).not.toHaveBeenCalled();
    });

    it('встроенная миниатюра огромна, а кадр самой картинки обычный — идёт кадр картинки', async () => {
      const d = deps();
      const fine = await file('exif-fine.jpg', jpegHeader(1920, 1080, { embedded: { width: 60000, height: 60000 } }));

      expect(await imageThumbnail(fine, d)).toBe('data:image/png;base64,read');
    });
  });
});
