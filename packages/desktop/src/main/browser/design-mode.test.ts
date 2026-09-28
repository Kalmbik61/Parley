import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { S } from '../../shared/strings.js';
import { captureRect, createDesignMode, PICK_LIMITS, PICK_WORLD_ID, pickUrl, validatePick } from './design-mode.js';

/** Данные элемента, как их шлёт guest-pick.js. */
function rawPick(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    selector: 'body > main > button.save',
    text: 'Save',
    html: '<button class="save">Save</button>',
    styles: { display: 'flex', color: 'rgb(0, 0, 0)' },
    rect: { x: 10, y: 20, width: 100, height: 40 },
    viewport: { width: 800, height: 600 },
    devicePixelRatio: 2,
    ...extra,
  };
}

describe('validatePick (тест 1 куска 9.3a)', () => {
  it('лишнее поле выкинуто, известные — как есть', () => {
    const result = validatePick(rawPick({ evil: 'x', url: 'https://evil.example/' }));
    expect(result).toEqual({
      selector: 'body > main > button.save',
      text: 'Save',
      html: '<button class="save">Save</button>',
      styles: { display: 'flex', color: 'rgb(0, 0, 0)' },
      rect: { x: 10, y: 20, width: 100, height: 40 },
      viewport: { width: 800, height: 600 },
    });
  });

  it('html 10 000 символов → 4096 и …(truncated); text 1000 → 500', () => {
    const result = validatePick(rawPick({ html: 'h'.repeat(10_000), text: 't'.repeat(1000) }));
    expect(result?.html).toBe('h'.repeat(PICK_LIMITS.html) + S.designBlock.truncated);
    expect(result?.text).toBe('t'.repeat(PICK_LIMITS.text));
    // Граница: ровно 4096 — без пометки.
    expect(validatePick(rawPick({ html: 'h'.repeat(4096) }))?.html).toBe('h'.repeat(4096));
  });

  it('обрезка не рвёт суррогатную пару', () => {
    const result = validatePick(rawPick({ text: '😀'.repeat(600) }));
    expect(Array.from(result?.text ?? '')).toHaveLength(500);
    expect(result?.text).toBe('😀'.repeat(500));
  });

  it('нет selector или viewport, неверные типы → null', () => {
    const noSelector = rawPick();
    delete noSelector.selector;
    const noViewport = rawPick();
    delete noViewport.viewport;
    expect(validatePick(noSelector)).toBeNull();
    expect(validatePick(noViewport)).toBeNull();
    expect(validatePick(null)).toBeNull();
    expect(validatePick('x')).toBeNull();
    expect(validatePick([])).toBeNull();
    expect(validatePick(rawPick({ rect: { x: 1, y: 2, width: Number.NaN, height: 3 } }))).toBeNull();
    expect(validatePick(rawPick({ rect: { x: 1, y: 2, width: -1, height: 3 } }))).toBeNull();
    expect(validatePick(rawPick({ viewport: { width: 0, height: 600 } }))).toBeNull();
    expect(validatePick(rawPick({ styles: 'display:none' }))).toBeNull();
    expect(validatePick(rawPick({ text: 42 }))).toBeNull();
  });

  it('стили — только из списка и строками; селектор — не больше 12 звеньев', () => {
    const links = Array.from({ length: 20 }, (_, i) => `div.l${i}`);
    const result = validatePick(
      rawPick({ styles: { display: 'block', 'x-evil': 'a', color: 5 }, selector: links.join(' > ') }),
    );
    expect(result?.styles).toEqual({ display: 'block' });
    expect(result?.selector).toBe(links.slice(-PICK_LIMITS.selectorLinks).join(' > '));
  });
});

describe('captureRect (тест 2 куска 9.3a)', () => {
  const viewport = { width: 800, height: 600 };

  it('элемент целиком виден — тот же прямоугольник', () => {
    expect(captureRect({ x: 10, y: 20, width: 100, height: 40 }, viewport, 1)).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 40,
    });
  });

  it('частично за правым краем — пересечение с видимой областью', () => {
    expect(captureRect({ x: 750, y: 20, width: 100, height: 40 }, viewport, 1)).toEqual({
      x: 750,
      y: 20,
      width: 50,
      height: 40,
    });
    expect(captureRect({ x: -30, y: -10, width: 100, height: 40 }, viewport, 1)).toEqual({
      x: 0,
      y: 0,
      width: 70,
      height: 30,
    });
  });

  it('целиком вне видимой области или пустой — null', () => {
    expect(captureRect({ x: 900, y: 20, width: 100, height: 40 }, viewport, 1)).toBeNull();
    expect(captureRect({ x: 10, y: -100, width: 100, height: 40 }, viewport, 1)).toBeNull();
    expect(captureRect({ x: 10, y: 20, width: 0, height: 40 }, viewport, 1)).toBeNull();
  });

  it('zoomFactor 1.5 умножает прямоугольник', () => {
    expect(captureRect({ x: 10, y: 20, width: 100, height: 40 }, viewport, 1.5)).toEqual({
      x: 15,
      y: 30,
      width: 150,
      height: 60,
    });
  });
});

describe('pickUrl', () => {
  it('origin + pathname: без query, hash и user:pass@', () => {
    expect(pickUrl('https://u:p@x.y/a?q=1#h')).toBe('https://x.y/a');
    expect(pickUrl('http://127.0.0.1:5173/settings')).toBe('http://127.0.0.1:5173/settings');
    expect(pickUrl('about:blank')).toBe('about:blank');
    expect(pickUrl('not a url')).toBe('');
  });
});

/** Подставной NativeImage: размер в DIP, resize отдаёт уменьшенный. */
function fakeImage(width: number, height: number): {
  isEmpty: () => boolean;
  getSize: () => { width: number; height: number };
  toPNG: () => Buffer;
  toDataURL: () => string;
  resize: ReturnType<typeof vi.fn>;
} {
  return {
    isEmpty: () => width === 0,
    getSize: () => ({ width, height }),
    toPNG: () => Buffer.from(`png-${width}x${height}`),
    toDataURL: () => `data:image/png;base64,${width}x${height}`,
    resize: vi.fn((options: { width: number }) =>
      fakeImage(options.width, Math.round((height * options.width) / width)),
    ),
  };
}

/** Подставной гость: события — EventEmitter, скрипт выбора — отложенный промис теста. */
function fakeGuest(url = 'https://u:p@x.y/a?q=1#h') {
  const scripts: Array<{ resolve: (value: unknown) => void; reject: (error: unknown) => void }> = [];
  const guest = Object.assign(new EventEmitter(), {
    id: 7,
    isDestroyed: vi.fn().mockReturnValue(false),
    getURL: vi.fn().mockReturnValue(url),
    getZoomFactor: vi.fn().mockReturnValue(1),
    capturePage: vi.fn(async () => fakeImage(800, 400)),
    executeJavaScriptInIsolatedWorld: vi.fn(
      (_world: number, sources: Array<{ code: string }>) =>
        new Promise((resolve, reject) => {
          // Скрипт отмены отвечает сразу; скрипт выбора ждёт теста.
          if (sources[0]?.code === 'GUEST_SCRIPT') scripts.push({ resolve, reject });
          else resolve(undefined);
        }),
    ),
  });
  return { guest, scripts };
}

function setup(guestUrl?: string) {
  const { guest, scripts } = fakeGuest(guestUrl);
  const saveImage = vi.fn<(png: Buffer) => Promise<string | null>>(async () => '/h/drops/a.png');
  const mode = createDesignMode({
    fromId: (id) => (id === 7 ? (guest as unknown as WebContents) : null),
    saveImage,
    guestScript: 'GUEST_SCRIPT',
  });
  /** Ждём, пока start дойдёт до вызова скрипта. */
  const scriptCalled = async (count = 1): Promise<void> => {
    await vi.waitFor(() => expect(scripts.length).toBe(count));
  };
  return { guest, scripts, saveImage, mode, scriptCalled };
}

describe('createDesignMode.start (тест 4 куска 9.3a)', () => {
  it('скрипт — в изолированном мире 1001; url — pickUrl(getURL()), а не из данных страницы; снимок в drops', async () => {
    const { guest, scripts, saveImage, mode, scriptCalled } = setup();
    const pending = mode.start(7);
    await scriptCalled();
    expect(guest.executeJavaScriptInIsolatedWorld).toHaveBeenCalledWith(PICK_WORLD_ID, [{ code: 'GUEST_SCRIPT' }]);
    scripts[0]?.resolve(rawPick({ url: 'https://evil.example/phish' }));

    const result = await pending;
    expect(result?.url).toBe('https://x.y/a');
    expect(result?.selector).toBe('body > main > button.save');
    expect(result?.imagePath).toBe('/h/drops/a.png');
    expect(guest.capturePage).toHaveBeenCalledWith({ x: 10, y: 20, width: 100, height: 40 });
    expect(saveImage).toHaveBeenCalledWith(Buffer.from('png-800x400'));
    // Миниатюра — data:image/png шириной не больше 320.
    expect(result?.thumbnail).toBe('data:image/png;base64,320x160');
  });

  it('узкий снимок не растягивается до 320', async () => {
    const { guest, scripts, mode, scriptCalled } = setup();
    guest.capturePage.mockResolvedValueOnce(fakeImage(100, 40));
    const pending = mode.start(7);
    await scriptCalled();
    scripts[0]?.resolve(rawPick());
    expect((await pending)?.thumbnail).toBe('data:image/png;base64,100x40');
  });

  it('масштаб страницы переводит CSS-пиксели в DIP', async () => {
    const { guest, scripts, mode, scriptCalled } = setup();
    guest.getZoomFactor.mockReturnValue(1.5);
    const pending = mode.start(7);
    await scriptCalled();
    scripts[0]?.resolve(rawPick());
    await pending;
    expect(guest.capturePage).toHaveBeenCalledWith({ x: 15, y: 30, width: 150, height: 60 });
  });

  it('capturePage бросил — imagePath и thumbnail равны null, данные есть', async () => {
    const { guest, scripts, saveImage, mode, scriptCalled } = setup();
    guest.capturePage.mockRejectedValueOnce(new Error('capture failed'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const pending = mode.start(7);
    await scriptCalled();
    scripts[0]?.resolve(rawPick());
    const result = await pending;
    warn.mockRestore();
    expect(result).toMatchObject({ selector: 'body > main > button.save', imagePath: null, thumbnail: null });
    expect(saveImage).not.toHaveBeenCalled();
  });

  it('saveImage не сохранил — imagePath и thumbnail равны null', async () => {
    const { scripts, saveImage, mode, scriptCalled } = setup();
    saveImage.mockResolvedValueOnce(null);
    const pending = mode.start(7);
    await scriptCalled();
    scripts[0]?.resolve(rawPick());
    expect(await pending).toMatchObject({ imagePath: null, thumbnail: null });
  });

  it('элемент вне видимой области — без снимка', async () => {
    const { guest, scripts, mode, scriptCalled } = setup();
    const pending = mode.start(7);
    await scriptCalled();
    scripts[0]?.resolve(rawPick({ rect: { x: 10, y: 900, width: 100, height: 40 } }));
    expect(await pending).toMatchObject({ imagePath: null, thumbnail: null });
    expect(guest.capturePage).not.toHaveBeenCalled();
  });

  it('скрипт ответил null (Esc), неверной формой или упал — null', async () => {
    const { scripts, mode, scriptCalled } = setup();
    const esc = mode.start(7);
    await scriptCalled(1);
    scripts[0]?.resolve(null);
    expect(await esc).toBeNull();

    const bad = mode.start(7);
    await scriptCalled(2);
    scripts[1]?.resolve({ selector: 5 });
    expect(await bad).toBeNull();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failed = mode.start(7);
    await scriptCalled(3);
    scripts[2]?.reject(new Error('script failed'));
    expect(await failed).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('неизвестный или мёртвый гость — null без скрипта', async () => {
    const { guest, mode } = setup();
    expect(await mode.start(404)).toBeNull();
    guest.isDestroyed.mockReturnValue(true);
    expect(await mode.start(7)).toBeNull();
    expect(guest.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
  });
});

describe('выбор прерван (тест 5 куска 9.3a)', () => {
  it('did-start-navigation главного фрейма → null; поздний ответ скрипта итог не меняет', async () => {
    const { guest, scripts, mode, scriptCalled } = setup();
    const pending = mode.start(7);
    await scriptCalled();
    guest.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: 'https://x.y/b' });
    expect(await pending).toBeNull();
    scripts[0]?.resolve(rawPick());
    await Promise.resolve();
    expect(guest.capturePage).not.toHaveBeenCalled();
    // Слушатели сняты: гость не копит их от выбора к выбору.
    expect(guest.listenerCount('did-start-navigation')).toBe(0);
    expect(guest.listenerCount('render-process-gone')).toBe(0);
    expect(guest.listenerCount('destroyed')).toBe(0);
  });

  it('навигация внутри документа или подфрейма выбор не прерывает', async () => {
    const { guest, scripts, mode, scriptCalled } = setup();
    const pending = mode.start(7);
    await scriptCalled();
    guest.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true, url: 'https://x.y/a#b' });
    guest.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false, url: 'https://ads.example/' });
    scripts[0]?.resolve(rawPick());
    expect((await pending)?.selector).toBe('body > main > button.save');
  });

  it.each(['render-process-gone', 'destroyed'])('%s → null', async (event) => {
    const { guest, scripts, mode, scriptCalled } = setup();
    const pending = mode.start(7);
    await scriptCalled();
    guest.emit(event, {}, { reason: 'crashed' });
    expect(await pending).toBeNull();
    scripts[0]?.resolve(rawPick());
    await Promise.resolve();
    expect(guest.capturePage).not.toHaveBeenCalled();
  });

  it('снимок ещё идёт, а страница ушла — null, поздний снимок отброшен', async () => {
    const { guest, scripts, mode, scriptCalled } = setup();
    let finishCapture: (image: ReturnType<typeof fakeImage>) => void = () => undefined;
    guest.capturePage.mockReturnValueOnce(
      new Promise((resolve) => {
        finishCapture = resolve;
      }),
    );
    const pending = mode.start(7);
    await scriptCalled();
    scripts[0]?.resolve(rawPick());
    await vi.waitFor(() => expect(guest.capturePage).toHaveBeenCalled());
    guest.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: 'https://x.y/b' });
    finishCapture(fakeImage(800, 400));
    expect(await pending).toBeNull();
  });

  it('cancel → null и скрипт отмены в том же мире; новый start отменяет прежний', async () => {
    const { guest, scripts, mode, scriptCalled } = setup();
    const first = mode.start(7);
    await scriptCalled(1);
    const second = mode.start(7);
    expect(await first).toBeNull();
    await scriptCalled(2);

    await mode.cancel(7);
    expect(await second).toBeNull();
    const cancelCalls = guest.executeJavaScriptInIsolatedWorld.mock.calls.filter(
      ([, sources]) => sources[0]?.code !== 'GUEST_SCRIPT',
    );
    expect(cancelCalls.length).toBeGreaterThan(0);
    expect(cancelCalls.every(([world]) => world === PICK_WORLD_ID)).toBe(true);
    // Поздние ответы обоих скриптов ничего не меняют.
    scripts[0]?.resolve(rawPick());
    scripts[1]?.resolve(rawPick());
    await Promise.resolve();
    expect(guest.capturePage).not.toHaveBeenCalled();
  });

  it('cancel без выбора и у неизвестного гостя — тихо', async () => {
    const { mode } = setup();
    await expect(mode.cancel(7)).resolves.toBeUndefined();
    await expect(mode.cancel(404)).resolves.toBeUndefined();
  });
});
