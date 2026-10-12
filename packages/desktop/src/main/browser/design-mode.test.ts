import { EventEmitter } from 'node:events';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { S } from '../../shared/strings.js';
import { captureClip, createDesignMode, cropRect, PICK_LIMITS, PICK_WORLD_ID, pickUrl, validatePick } from './design-mode.js';
import type { CdpSender } from './element-info.js';

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
    point: { x: 30, y: 40 },
    shift: false,
    scroll: { x: 0, y: 0 },
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
      viewport: { width: 800, height: 600, dpr: 2 },
      point: { x: 30, y: 40 },
      shift: false,
      scroll: { x: 0, y: 0 },
    });
  });

  it('html 10 000 символов → 4096 и …(truncated); text 1000 → 500', () => {
    const result = validatePick(rawPick({ html: 'h'.repeat(10_000), text: 't'.repeat(1000) }));
    expect(result?.html).toBe('h'.repeat(PICK_LIMITS.html) + S.contextFile.truncated);
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
    expect(validatePick(rawPick({ devicePixelRatio: undefined }))).toBeNull();
    expect(validatePick(rawPick({ point: { x: 'a', y: 1 } }))?.point).toBeNull();
    expect(validatePick(rawPick({ shift: 'yes' }))?.shift).toBe(false);
  });

  it('стили — только из списка и строками; селектор — не больше 12 звеньев', () => {
    const links = Array.from({ length: 20 }, (_, i) => `div.l${i}`);
    const result = validatePick(
      rawPick({ styles: { display: 'block', 'x-evil': 'a', color: 5 }, selector: links.join(' > ') }),
    );
    expect(result?.styles).toEqual({ display: 'block' });
    expect(result?.selector).toBe(links.slice(-PICK_LIMITS.selectorLinks).join(' > '));
  });

  it('devicePixelRatio не больше нуля — null; прокрутка без поля или мусором — {0, 0}, верная — как есть', () => {
    expect(validatePick(rawPick({ devicePixelRatio: 0 }))).toBeNull();
    expect(validatePick(rawPick({ devicePixelRatio: -1 }))).toBeNull();
    const noScroll = rawPick();
    delete noScroll.scroll;
    expect(validatePick(noScroll)?.scroll).toEqual({ x: 0, y: 0 });
    expect(validatePick(rawPick({ scroll: { x: 'a', y: 1 } }))?.scroll).toEqual({ x: 0, y: 0 });
    expect(validatePick(rawPick({ scroll: { x: 5, y: 250 } }))?.scroll).toEqual({ x: 5, y: 250 });
  });
});

describe('validatePick — предел длины селектора (fix-9)', () => {
  it('одно звено длиннее предела — обрезано по PICK_LIMITS.selector, а не по пределу html', () => {
    expect(PICK_LIMITS.selector).toBeLessThan(PICK_LIMITS.html);
    const result = validatePick(rawPick({ selector: `div.${'x'.repeat(5000)}` }));
    expect(result?.selector.length).toBe(PICK_LIMITS.selector);
  });
});

describe('cropRect — запасной снимок по Orca (вырезка из capturePage видимой части)', () => {
  const viewport = { width: 800 };
  const bitmap = { width: 800, height: 600 };

  it('элемент целиком виден — тот же прямоугольник; частично за краем — пересечение с картинкой', () => {
    expect(cropRect({ x: 10, y: 20, width: 100, height: 40 }, viewport, bitmap)).toEqual({ x: 10, y: 20, width: 100, height: 40 });
    expect(cropRect({ x: 750, y: 20, width: 100, height: 40 }, viewport, bitmap)).toEqual({ x: 750, y: 20, width: 50, height: 40 });
    expect(cropRect({ x: -30, y: -10, width: 100, height: 40 }, viewport, bitmap)).toEqual({ x: 0, y: 0, width: 70, height: 30 });
  });

  it('целиком вне картинки или пустой — null', () => {
    expect(cropRect({ x: 900, y: 20, width: 100, height: 40 }, viewport, bitmap)).toBeNull();
    expect(cropRect({ x: 10, y: -100, width: 100, height: 40 }, viewport, bitmap)).toBeNull();
    expect(cropRect({ x: 10, y: 20, width: 0, height: 40 }, viewport, bitmap)).toBeNull();
  });

  it('множитель — ширина картинки / ширина вьюпорта: DPR 2 и масштаб 1,5 — ×3, без знания о них', () => {
    expect(cropRect({ x: 10, y: 20, width: 100, height: 40 }, viewport, { width: 2400, height: 1800 })).toEqual({ x: 30, y: 60, width: 300, height: 120 });
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

/** Подставной NativeImage: размер в пикселях картинки, crop отдаёт вырезку (запасной снимок по Orca). */
interface FakeImage {
  isEmpty: () => boolean;
  getSize: () => { width: number; height: number };
  toPNG: () => Buffer;
  crop: ReturnType<typeof vi.fn>;
}

function fakeImage(width: number, height: number): FakeImage {
  return {
    isEmpty: () => width === 0,
    getSize: () => ({ width, height }),
    toPNG: () => Buffer.from(`png-${width}x${height}`),
    crop: vi.fn((rect: { width: number; height: number }) => fakeImage(rect.width, rect.height)),
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

/** Подставной инспектор: ответ по имени метода CDP; Error — отказ; нет ответа — пустой объект (снимка CDP нет — capturePage). */
function fakeInspector(answers: Record<string, unknown> = {}) {
  return {
    send: vi.fn(async (_id: number, method: string): Promise<unknown> => {
      const answer = answers[method];
      if (answer instanceof Error) throw answer;
      return answer ?? {};
    }),
  };
}

function setup(guestUrl?: string, answers: Record<string, unknown> = {}) {
  const { guest, scripts } = fakeGuest(guestUrl);
  const saveImage = vi.fn<(png: Buffer) => Promise<string | null>>(async () => '/h/drops/a.png');
  const inspector = fakeInspector(answers);
  const mode = createDesignMode({
    fromId: (id) => (id === 7 ? (guest as unknown as WebContents) : null),
    saveImage,
    guestScript: 'GUEST_SCRIPT',
    inspector: inspector as unknown as CdpSender,
  });
  /** Ждём, пока start дойдёт до вызова скрипта. */
  const scriptCalled = async (count = 1): Promise<void> => {
    await vi.waitFor(() => expect(scripts.length).toBe(count));
  };
  return { guest, scripts, saveImage, mode, scriptCalled, inspector };
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
    // CDP снимка не дал (подставной инспектор отвечает пустым) — вырезка из capturePage() видимой части по Orca.
    expect(guest.capturePage).toHaveBeenCalledWith();
    expect(saveImage).toHaveBeenCalledWith(Buffer.from('png-100x40'));
    expect(result?.thumbnail).toBeNull();
    expect(result).toMatchObject({ point: { x: 30, y: 40 }, shift: false, viewport: { width: 800, height: 600, dpr: 2 } });
  });

  it('запасной снимок: множитель — ширина картинки / ширина вьюпорта (DPR, масштаб и эмуляция — измерены)', async () => {
    const { guest, scripts, mode, scriptCalled, saveImage } = setup();
    const view = fakeImage(1200, 900);
    guest.capturePage.mockResolvedValueOnce(view);
    const pending = mode.start(7);
    await scriptCalled();
    scripts[0]?.resolve(rawPick());
    await pending;
    expect(view.crop).toHaveBeenCalledWith({ x: 15, y: 30, width: 150, height: 60 });
    expect(saveImage).toHaveBeenCalledWith(Buffer.from('png-150x60'));
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

  it('элемент вне видимой области, а CDP не ответил — без снимка: вырезать из видимой части нечего', async () => {
    const { scripts, saveImage, mode, scriptCalled } = setup();
    const pending = mode.start(7);
    await scriptCalled();
    scripts[0]?.resolve(rawPick({ rect: { x: 10, y: 900, width: 100, height: 40 } }));
    expect((await pending)?.imagePath).toBeNull();
    expect(saveImage).not.toHaveBeenCalled();
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

  it('навигация главного фрейма — скрипт отмены в мир 1001: документ, который не сменился (скачивание), не держит оверлей (fix-9)', async () => {
    const { guest, mode, scriptCalled } = setup();
    const pending = mode.start(7);
    await scriptCalled();
    guest.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: 'https://x.y/file.zip' });
    expect(await pending).toBeNull();
    const cancelCalls = guest.executeJavaScriptInIsolatedWorld.mock.calls.filter(
      ([, sources]) => sources[0]?.code !== 'GUEST_SCRIPT',
    );
    expect(cancelCalls).toEqual([[PICK_WORLD_ID, [{ code: 'globalThis.__parleyPickCancel?.()' }]]]);
  });

  it('скрипт отмены упал (документ уже уничтожен) — тихо; мёртвому гостю не шлётся (fix-9)', async () => {
    const { guest, mode, scriptCalled } = setup();
    const pending = mode.start(7);
    await scriptCalled();
    guest.executeJavaScriptInIsolatedWorld.mockImplementationOnce(() => Promise.reject(new Error('Script failed to execute')));
    guest.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: 'https://x.y/b' });
    expect(await pending).toBeNull();
    await Promise.resolve();

    const second = setup();
    const next = second.mode.start(7);
    await second.scriptCalled();
    second.guest.isDestroyed.mockReturnValue(true);
    second.guest.emit('destroyed');
    expect(await next).toBeNull();
    expect(second.guest.executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(1);
  });

  it('загрузка из гостя с активным выбором — null и скрипт отмены в мир 1001; от другого гостя — выбор не тронут (fix-9b)', async () => {
    const { guest, mode, scriptCalled } = setup();
    const pending = mode.start(7);
    await scriptCalled();
    const cancelCalls = () =>
      guest.executeJavaScriptInIsolatedWorld.mock.calls.filter(([, sources]) => sources[0]?.code !== 'GUEST_SCRIPT');

    // Чужой гость: ни итога, ни скрипта отмены.
    mode.downloadStarted(404);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(cancelCalls()).toEqual([]);

    mode.downloadStarted(7);
    expect(await pending).toBeNull();
    expect(cancelCalls()).toEqual([[PICK_WORLD_ID, [{ code: 'globalThis.__parleyPickCancel?.()' }]]]);
  });

  it('загрузка из гостя без выбора — скрипт не шлётся (fix-9b)', async () => {
    const { guest, mode } = setup();
    mode.downloadStarted(7);
    expect(guest.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
  });

  it('cancel без выбора и у неизвестного гостя — тихо', async () => {
    const { mode } = setup();
    await expect(mode.cancel(7)).resolves.toBeUndefined();
    await expect(mode.cancel(404)).resolves.toBeUndefined();
  });
});

describe('Select: снимок CDP, роль и React (этап B, спека 3.8, 4.6; решения этапа 0)', () => {
  it('captureClip: координаты документа × масштаб страницы; высота — не больше поверхности вида; сторона — не больше captureSide', () => {
    const pick = { rect: { x: 10, y: 20, width: 100, height: 40 }, scroll: { x: 0, y: 2500 } };
    expect(captureClip(pick, 1, 600)).toEqual({ x: 10, y: 2520, width: 100, height: 40, scale: 1 });
    expect(captureClip(pick, 1.5, 600)).toEqual({ x: 15, y: 3780, width: 150, height: 60, scale: 1 });
    expect(captureClip({ rect: { x: 0, y: 0, width: 300, height: 900 }, scroll: { x: 0, y: 0 } }, 1, 203)?.height).toBe(203);
    expect(captureClip({ rect: { x: 0, y: 0, width: 9000, height: 50 }, scroll: { x: 0, y: 0 } }, 1, 600)?.width).toBe(PICK_LIMITS.captureSide);
    expect(captureClip({ rect: { x: 0, y: 0, width: 0, height: 50 }, scroll: { x: 0, y: 0 } }, 1, 600)).toBeNull();
  });

  it('снимок — обрезка CDP с captureBeyondViewport; capturePage — только мера поверхности: картинка 800×400 при DPR 2 — 200 CSS-пикселей', async () => {
    const { guest, scripts, saveImage, mode, scriptCalled, inspector } = setup(undefined, {
      'Page.captureScreenshot': { data: Buffer.from('cdp-png').toString('base64') },
    });
    const pending = mode.start(7);
    await scriptCalled();
    scripts[0]?.resolve(rawPick({ rect: { x: 10, y: 20, width: 100, height: 900 }, scroll: { x: 0, y: 300 } }));
    expect((await pending)?.imagePath).toBe('/h/drops/a.png');
    expect(inspector.send).toHaveBeenCalledWith(7, 'Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 10, y: 320, width: 100, height: 200, scale: 1 },
    });
    expect(saveImage).toHaveBeenCalledWith(Buffer.from('cdp-png'));
    expect(guest.capturePage).toHaveBeenCalledTimes(1);
  });

  it('роль, имя и React — по точке документа (точка вьюпорта + прокрутка, спайк 0.4); точка, ⇧ и размер — в результате', async () => {
    const { scripts, mode, scriptCalled, inspector } = setup(undefined, {
      'DOM.getNodeForLocation': { backendNodeId: 42 },
      'DOM.describeNode': { node: { localName: 'button', attributes: ['class', 'save'] } },
      'Accessibility.getPartialAXTree': { nodes: [{ backendDOMNodeId: 42, role: { value: 'button' }, name: { value: 'Save' } }] },
      'DOM.resolveNode': { object: { objectId: 'o1' } },
      'Runtime.callFunctionOn': { result: { value: [{ name: 'SaveButton', source: 'src/SaveButton.tsx:12', approx: false }] } },
    });
    const pending = mode.start(7);
    await scriptCalled();
    scripts[0]?.resolve(rawPick({ shift: true, scroll: { x: 0, y: 300 } }));
    expect(await pending).toMatchObject({
      point: { x: 30, y: 40 },
      shift: true,
      viewport: { width: 800, height: 600, dpr: 2 },
      role: 'button',
      name: 'Save',
      react: [{ name: 'SaveButton', source: 'src/SaveButton.tsx:12', approx: false }],
    });
    expect(inspector.send).toHaveBeenCalledWith(7, 'DOM.getNodeForLocation', { x: 30, y: 340, includeUserAgentShadowDOM: false });
  });

  it('роль и React не ответили за PICK_LIMITS.infoMs — выбор без них, не висит', async () => {
    const { scripts, mode, scriptCalled, inspector } = setup();
    inspector.send.mockImplementation(async (_id: number, method: string): Promise<unknown> => (method === 'DOM.enable' ? new Promise(() => undefined) : {}));
    const pending = mode.start(7);
    await scriptCalled();
    vi.useFakeTimers();
    try {
      scripts[0]?.resolve(rawPick());
      await vi.advanceTimersByTimeAsync(PICK_LIMITS.infoMs);
      const result = await pending;
      expect(result?.selector).toBe('body > main > button.save');
      expect(result?.role).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('CDP отказал — запасной снимок из capturePage, выбор не теряется', async () => {
    const { scripts, saveImage, mode, scriptCalled } = setup(undefined, { 'Page.captureScreenshot': new Error('boom') });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const pending = mode.start(7);
    await scriptCalled();
    scripts[0]?.resolve(rawPick());
    const result = await pending;
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    expect(result?.imagePath).toBe('/h/drops/a.png');
    expect(saveImage).toHaveBeenCalledWith(Buffer.from('png-100x40'));
  });

  it('capturePage вернул пустую картинку — поверхность по высоте вьюпорта, снимок CDP всё равно идёт', async () => {
    const { guest, scripts, saveImage, mode, scriptCalled, inspector } = setup(undefined, {
      'Page.captureScreenshot': { data: Buffer.from('cdp-png').toString('base64') },
    });
    guest.capturePage.mockResolvedValueOnce(fakeImage(0, 0));
    const pending = mode.start(7);
    await scriptCalled();
    scripts[0]?.resolve(rawPick({ rect: { x: 10, y: 20, width: 100, height: 900 } }));
    expect((await pending)?.imagePath).toBe('/h/drops/a.png');
    expect(inspector.send).toHaveBeenCalledWith(7, 'Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 10, y: 20, width: 100, height: 600, scale: 1 },
    });
    expect(saveImage).toHaveBeenCalledWith(Buffer.from('cdp-png'));
  });

  it('масштаб страницы (getZoomFactor) — множитель обрезки CDP: без него при масштабе 2 она пуста', async () => {
    const { guest, scripts, mode, scriptCalled, inspector } = setup(undefined, {
      'Page.captureScreenshot': { data: Buffer.from('cdp-png').toString('base64') },
    });
    guest.getZoomFactor.mockReturnValue(1.5);
    const pending = mode.start(7);
    await scriptCalled();
    scripts[0]?.resolve(rawPick());
    await pending;
    expect(inspector.send).toHaveBeenCalledWith(7, 'Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 15, y: 30, width: 150, height: 60, scale: 1 },
    });
  });

  it('точки нет (под центром другой узел) — роль и React не ищутся: main не гадает; данные и снимок на месте', async () => {
    const { scripts, mode, scriptCalled, inspector } = setup(undefined, {
      'DOM.getNodeForLocation': { backendNodeId: 42 },
      'DOM.describeNode': { node: { localName: 'button', attributes: ['class', 'save'] } },
    });
    const pending = mode.start(7);
    await scriptCalled();
    scripts[0]?.resolve(rawPick({ point: null }));
    const result = await pending;
    expect(result).toMatchObject({ selector: 'body > main > button.save', point: null, imagePath: '/h/drops/a.png' });
    expect(result?.role).toBeUndefined();
    expect(inspector.send.mock.calls.map(([, method]) => method)).not.toContain('DOM.getNodeForLocation');
  });
});

describe('рамочный: скрипты страницы — только в изолированном мире (Фокус ревью 6)', () => {
  it('в коде main нет executeJavaScript мира страницы (у Orca так исполнен весь выбор)', () => {
    const mainDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const files = (readdirSync(mainDir, { recursive: true }) as string[]).filter((file) => /\.(ts|js)$/.test(file) && !file.includes('.test.'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(readFileSync(path.join(mainDir, file), 'utf8'), file).not.toMatch(/\.executeJavaScript\(/);
  });
});
