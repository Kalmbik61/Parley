// packages/desktop/src/main/browser/annotate.test.ts
import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONTEXT_LIMITS } from '../../shared/context-markdown.js';
import { S } from '../../shared/strings.js';
import { createAnnotate, parseAnnotationPins, validateAnnotationPick } from './annotate.js';
import { PICK_WORLD_ID } from './design-mode.js';
import type { CdpSender } from './element-info.js';

const VIEWPORT = { width: 1280, height: 800, dpr: 2 };

function rawElement(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'element',
    key: 'a1',
    selector: 'body > main > button.save',
    text: 'Save',
    html: '<button class="save">Save</button>',
    styles: { color: 'rgb(0, 0, 0)', 'box-shadow': 'none', evil: 'x' },
    point: { x: 30, y: 40 },
    anchor: { fx: 0.1, fy: 0.2 },
    viewport: VIEWPORT,
    ...extra,
  };
}

function rawRegion(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'region',
    key: 'a2',
    rect: { x: 24, y: 1200, width: 308, height: 20 },
    elements: [{ selector: 'main', text: 'a' }, 'bad', { selector: 'section', text: 'b' }, { selector: 'div', text: 'c' }, { selector: 'p', text: 'd' }],
    anchor: { fx: 0.5, fy: -0.5 },
    viewport: VIEWPORT,
    ...extra,
  };
}

describe('validateAnnotationPick (спека браузера 4.7)', () => {
  it('метка на элементе: ключевые стили, HTML до 1 КБ с пометкой, точка для CDP', () => {
    expect(validateAnnotationPick(rawElement({ html: 'h'.repeat(5000) }))).toEqual({
      kind: 'element',
      key: 'a1',
      selector: 'body > main > button.save',
      text: 'Save',
      html: `${'h'.repeat(CONTEXT_LIMITS.annotationHtml)}${S.contextFile.truncated}`,
      styles: { color: 'rgb(0, 0, 0)' },
      anchor: { fx: 0.1, fy: 0.2 },
      viewport: VIEWPORT,
      point: { x: 30, y: 40 },
      scroll: { x: 0, y: 0 },
    });
  });

  it('рамка: элементы под ней — первые три годных из первых трёх, доля вьюпорта — в пределах 0…1', () => {
    expect(validateAnnotationPick(rawRegion())).toEqual({
      kind: 'region',
      key: 'a2',
      rect: { x: 24, y: 1200, width: 308, height: 20 },
      elements: [
        { selector: 'main', text: 'a' },
        { selector: 'section', text: 'b' },
      ],
      anchor: { fx: 0.5, fy: 0 },
      viewport: VIEWPORT,
    });
  });

  it('правка — номер 1…20; чужой вид, ключ, вьюпорт или доля — null', () => {
    expect(validateAnnotationPick({ kind: 'edit', n: 3 })).toEqual({ kind: 'edit', n: 3 });
    for (const bad of [
      { kind: 'edit', n: 0 },
      { kind: 'edit', n: 21 },
      { kind: 'edit', n: 1.5 },
      rawElement({ key: '../x' }),
      rawElement({ viewport: { width: 0, height: 1, dpr: 1 } }),
      rawElement({ anchor: { fx: 'a', fy: 0 } }),
      rawElement({ styles: 'x' }),
      rawRegion({ rect: { x: 0, y: 0, width: -1, height: 1 } }),
      { kind: 'cookie' },
      null,
    ]) {
      expect(validateAnnotationPick(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('parseAnnotationPins', () => {
  it('до 20 меток с номером 1…20 и ключом a<число>; иначе null', () => {
    expect(parseAnnotationPins([{ n: 1, key: 'a1', extra: 1 }])).toEqual([{ n: 1, key: 'a1' }]);
    expect(parseAnnotationPins([])).toEqual([]);
    expect(parseAnnotationPins(Array.from({ length: 21 }, (_, index) => ({ n: (index % 20) + 1, key: `a${index}` })))).toBeNull();
    expect(parseAnnotationPins([{ n: 1, key: 'x"); alert(1); ("' }])).toBeNull();
    expect(parseAnnotationPins('x')).toBeNull();
  });

  it('ключ не повторяется: повтор — метки двух документов в одном списке; номера не обязаны идти подряд', () => {
    expect(parseAnnotationPins([{ n: 1, key: 'a1' }, { n: 2, key: 'a1' }])).toBeNull();
    expect(parseAnnotationPins([{ n: 2, key: 'a1' }, { n: 3, key: 'a2' }])).toEqual([{ n: 2, key: 'a1' }, { n: 3, key: 'a2' }]);
  });
});

/** Подставной гость: события — EventEmitter; скрипт меток ждёт теста, служебные скрипты отвечают сразу. */
function fakeGuest() {
  const scripts: Array<{ resolve: (value: unknown) => void; reject: (error: unknown) => void }> = [];
  const codes: string[] = [];
  let count: unknown = 1;
  let syncAnswer: unknown = null;
  const guest = Object.assign(new EventEmitter(), {
    id: 7,
    isDestroyed: vi.fn().mockReturnValue(false),
    capturePage: vi.fn(async () => ({ isEmpty: () => false, toPNG: () => Buffer.from('visible-png') })),
    executeJavaScriptInIsolatedWorld: vi.fn(
      (_world: number, sources: Array<{ code: string }>) =>
        new Promise((resolve, reject) => {
          const code = sources[0]?.code ?? '';
          codes.push(code);
          if (code === 'GUEST_SCRIPT') scripts.push({ resolve, reject });
          else if (code.includes('count()')) resolve(count);
          else if (code.includes('.sync(')) resolve(syncAnswer);
          else resolve(undefined);
        }),
    ),
  });
  return {
    guest,
    scripts,
    codes,
    setCount: (value: unknown) => {
      count = value;
    },
    setSync: (value: unknown) => {
      syncAnswer = value;
    },
  };
}

function setup(answers: Record<string, unknown> = {}) {
  const fake = fakeGuest();
  const send = vi.fn(async (_id: number, method: string): Promise<unknown> => {
    const answer = answers[method];
    if (answer instanceof Error) throw answer;
    return answer ?? {};
  });
  const saveImage = vi.fn<(png: Buffer) => Promise<string | null>>(async () => '/h/drops/page.png');
  const annotate = createAnnotate({
    fromId: (id) => (id === 7 ? (fake.guest as unknown as WebContents) : null),
    saveImage,
    guestScript: 'GUEST_SCRIPT',
    inspector: { send } as unknown as CdpSender,
  });
  const scriptCalled = async (count = 1): Promise<void> => {
    await vi.waitFor(() => expect(fake.scripts.length).toBe(count));
  };
  return { ...fake, send, saveImage, annotate, scriptCalled };
}

afterEach(() => vi.restoreAllMocks());

describe('createAnnotate.start', () => {
  it('скрипт — в мире 1001; метка на элементе дочитана ролью и React по точке документа; точка и прокрутка в окно не уходят', async () => {
    const { guest, scripts, annotate, scriptCalled, send } = setup({
      'DOM.getNodeForLocation': { backendNodeId: 42 },
      'DOM.describeNode': { node: { localName: 'button', attributes: ['class', 'save'] } },
      'Accessibility.getPartialAXTree': { nodes: [{ backendDOMNodeId: 42, role: { value: 'button' }, name: { value: 'Save' } }] },
    });
    const pending = annotate.start(7);
    await scriptCalled();
    expect(guest.executeJavaScriptInIsolatedWorld).toHaveBeenCalledWith(PICK_WORLD_ID, [{ code: 'GUEST_SCRIPT' }]);
    scripts[0]?.resolve(rawElement({ scroll: { x: 0, y: 500 } }));
    const pick = await pending;
    expect(pick).toMatchObject({ kind: 'element', key: 'a1', role: 'button', name: 'Save' });
    expect(pick).not.toHaveProperty('point');
    expect(pick).not.toHaveProperty('scroll');
    expect(send).toHaveBeenCalledWith(7, 'DOM.getNodeForLocation', { x: 30, y: 540, includeUserAgentShadowDOM: false });
  });

  it('рамка и правка — как есть; Esc — null', async () => {
    const { scripts, annotate, scriptCalled } = setup();
    const region = annotate.start(7);
    await scriptCalled(1);
    scripts[0]?.resolve(rawRegion());
    expect((await region)?.kind).toBe('region');
    const edit = annotate.start(7);
    await scriptCalled(2);
    scripts[1]?.resolve({ kind: 'edit', n: 1 });
    expect(await edit).toEqual({ kind: 'edit', n: 1 });
    const esc = annotate.start(7);
    await scriptCalled(3);
    scripts[2]?.resolve(null);
    expect(await esc).toBeNull();
  });

  it('навигация главного фрейма — null; неизвестный гость — null без скрипта', async () => {
    const { guest, annotate, scriptCalled } = setup();
    const pending = annotate.start(7);
    await scriptCalled();
    guest.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: 'http://x/b' });
    expect(await pending).toBeNull();
    expect(guest.listenerCount('did-start-navigation')).toBe(0);
    expect(await annotate.start(404)).toBeNull();
  });

  it('cancel — null, скрипт отмены в мире 1001', async () => {
    const { guest, annotate, scriptCalled } = setup();
    const pending = annotate.start(7);
    await scriptCalled();
    await annotate.cancel(7);
    expect(await pending).toBeNull();
    expect(guest.executeJavaScriptInIsolatedWorld).toHaveBeenCalledWith(PICK_WORLD_ID, [{ code: 'globalThis.__parleyAnnotate?.cancel()' }]);
  });
});

describe('createAnnotate.sync и capture', () => {
  it('sync: метки уходят JSON-ом в мир 1001; ответ разобран по номерам; скрипта нет — все null', async () => {
    const { annotate, codes, setSync } = setup();
    setSync([{ n: 1, rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 } }, { n: 2, rect: null }, { n: 9, rect: { x: 1, y: 1, width: 1, height: 1 } }]);
    expect(await annotate.sync(7, [{ n: 1, key: 'a1' }, { n: 2, key: 'a2' }])).toEqual([
      { n: 1, rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 } },
      { n: 2, rect: null },
    ]);
    expect(codes.at(-1)).toBe('globalThis.__parleyAnnotate?.sync([{"n":1,"key":"a1"},{"n":2,"key":"a2"}]) ?? null');
    setSync(null);
    expect(await annotate.sync(7, [{ n: 1, key: 'a1' }])).toEqual([{ n: 1, rect: null }]);
  });

  it('capture: меток нет — снимка нет и CDP не зовётся', async () => {
    const { annotate, setCount, send } = setup();
    setCount(0);
    expect(await annotate.capture(7)).toEqual({ path: null });
    expect(send).not.toHaveBeenCalled();
  });

  it('capture: только видимая часть — Page.captureScreenshot без clip и captureBeyondViewport (этап 0, 0.7)', async () => {
    const { annotate, send, saveImage } = setup({ 'Page.captureScreenshot': { data: Buffer.from('visible').toString('base64') } });
    expect(await annotate.capture(7)).toEqual({ path: '/h/drops/page.png' });
    expect(send).toHaveBeenCalledWith(7, 'Page.captureScreenshot', { format: 'png' });
    expect(send.mock.calls.map((call) => call[1])).toEqual(['Page.captureScreenshot']);
    expect(saveImage).toHaveBeenCalledWith(Buffer.from('visible'));
  });

  it('capture: CDP отказал — видимая часть через capturePage', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { annotate, guest, saveImage } = setup({ 'Page.captureScreenshot': new Error('not attached') });
    expect(await annotate.capture(7)).toEqual({ path: '/h/drops/page.png' });
    expect(guest.capturePage).toHaveBeenCalledWith();
    expect(saveImage).toHaveBeenCalledWith(Buffer.from('visible-png'));
  });
});
