// packages/desktop/src/main/browser/guest-annotate.test.ts
// @vitest-environment jsdom
// vitest.config.ts даёт src/main/** среду node, а скрипт меток живёт в странице — ему нужен DOM.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONTEXT_LIMITS } from '../../shared/context-markdown.js';

// Путь, а не URL: в jsdom глобальный URL — его, и readFileSync такой не примет.
const here = path.dirname(fileURLToPath(import.meta.url));
const guestScript = readFileSync(path.join(here, 'guest-annotate.js'), 'utf8');
const domScript = readFileSync(path.join(here, 'guest-dom.js'), 'utf8');

/** Доверенное событие так, как его шлёт сама jsdom (см. guest-pick.test.ts). */
const jsdomUtils = createRequire(import.meta.url)('jsdom/lib/generated/idl/utils.js') as {
  implForWrapper(wrapper: object): { isTrusted: boolean; _dispatch(eventImpl: unknown): boolean };
};

function dispatchTrusted(target: EventTarget, event: Event): Event {
  const eventImpl = jsdomUtils.implForWrapper(event);
  eventImpl.isTrusted = true;
  jsdomUtils.implForWrapper(target)._dispatch(eventImpl);
  return event;
}

function mouse(type: string, init: MouseEventInit = {}): MouseEvent {
  return new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 30, clientY: 30, ...init });
}

/** Клик человека: mousedown и mouseup в одной точке. */
function click(target: EventTarget, x = 30, y = 30): void {
  dispatchTrusted(target, mouse('mousedown', { clientX: x, clientY: y }));
  dispatchTrusted(target, mouse('mouseup', { clientX: x, clientY: y }));
}

function domRect(x: number, y: number, width: number, height: number): DOMRect {
  return { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height, toJSON: () => ({}) };
}

interface Controller {
  pick(): Promise<unknown>;
  cancel(): void;
  sync(pins: Array<{ n: number; key: string }>): Array<{ n: number; rect: unknown }>;
  count(): number;
  armed(): boolean;
  waiting(): boolean;
}

function controller(): Controller {
  return (globalThis as unknown as { __parleyAnnotate: Controller }).__parleyAnnotate;
}

/** Скрипт как в госте: помощники DOM и скрипт меток одной строкой, её значение — промис одной метки. */
function runScript(): Promise<unknown> {
  return (0, eval)(`${domScript}\n${guestScript}`) as Promise<unknown>;
}

/** Закрытый shadow-корень слоя меток: страница его не видит, тест ловит его при создании. */
let layer: ShadowRoot | null = null;

/** Номера меток, видимые сейчас: слой в документе, кружок не спрятан. */
function badges(): HTMLElement[] {
  if (layer === null || !layer.host.isConnected) return [];
  return Array.from(layer.querySelectorAll<HTMLElement>('.badge')).filter((badge) => badge.style.display !== 'none');
}

const pins = (): number => badges().length;
const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

describe('guest-annotate.js в jsdom (спека браузера 4.7; слой меток — по Orca)', () => {
  let form: HTMLFormElement;
  let button: HTMLButtonElement;
  const pageHandler = vi.fn();

  beforeEach(() => {
    delete (globalThis as { __parleyAnnotate?: unknown }).__parleyAnnotate;
    layer = null;
    const attach = Element.prototype.attachShadow;
    vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, init: ShadowRootInit) {
      layer = attach.call(this, init);
      return layer;
    });
    document.body.innerHTML = `
      <main class="page">
        <form class="login" id="f">
          <input type="password" value="secret">
          <button class="save primary" type="button">Save</button>
        </form>
      </main>`;
    form = document.querySelector('form') as HTMLFormElement;
    button = document.querySelector('button') as HTMLButtonElement;
    pageHandler.mockClear();
    button.addEventListener('mousedown', pageHandler);
    button.addEventListener('mouseup', pageHandler);
    // Чего нет в jsdom: скрипт читает это через document и элемент, как в браузере.
    document.elementFromPoint = vi.fn(() => form);
    document.elementsFromPoint = vi.fn(() => [button, form, document.querySelector('main') as Element, document.body, document.documentElement]);
    form.getBoundingClientRect = () => ({ x: 10, y: 20, width: 300, height: 120, top: 20, left: 10, right: 310, bottom: 140, toJSON: () => ({}) });
    // Вёрстки в jsdom нет, и getClientRects пуст у любого элемента — как у скрытого display:none (скрипт считает такой элемент
    // пропавшим). Форма на странице — одна коробка.
    form.getClientRects = () => [form.getBoundingClientRect()] as unknown as DOMRectList;
  });

  afterEach(() => {
    controller()?.cancel();
    vi.restoreAllMocks();
    // Слой меток живёт в body, рамка протяжки — прямо в <html>.
    document.body.innerHTML = '';
    for (const node of Array.from(document.documentElement.children)) if (node.tagName === 'DIV') node.remove();
  });

  it('клик человека — метка на элементе: данные без секретов, ключевые стили, доля вьюпорта, прокрутка; до страницы не дошёл; номер нарисован', async () => {
    const picking = runScript();
    expect(controller().waiting()).toBe(true);
    click(button);
    expect(controller().waiting()).toBe(false);
    const pick = (await picking) as Record<string, unknown>;
    expect(pick).toMatchObject({
      kind: 'element',
      key: 'a1',
      selector: 'form#f',
      point: { x: 30, y: 30 },
      scroll: { x: 0, y: 0 },
      anchor: { fx: 30 / window.innerWidth, fy: 30 / window.innerHeight },
      viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
    });
    expect(String(pick.html)).toContain('<input');
    expect(String(pick.html)).not.toContain('secret');
    expect(Object.keys(pick.styles as object).sort()).toEqual(['background-color', 'color', 'display', 'font-size', 'font-weight', 'height', 'margin', 'padding', 'position', 'width']);
    expect(pageHandler).not.toHaveBeenCalled();
    expect(pins()).toBe(1);
  });

  it('по Orca: слой — закрытый shadow-корень, странице меток не видно; метка идёт за живым прямоугольником элемента, за краем — спрятана', async () => {
    const picking = runScript();
    click(button);
    await picking;
    controller().sync([{ n: 1, key: 'a1' }]);
    expect(document.querySelector('.badge')).toBeNull();
    expect(layer?.host.shadowRoot).toBeNull();
    const badge = layer?.querySelector<HTMLElement>('[data-pin="1"]');
    // Кружок 24 px с центром в левом верхнем углу элемента (10, 20), но целиком во вьюпорте: слева -2 прижат к 0.
    expect(badge?.style.transform).toBe('translate3d(0px,8px,0)');
    // Элемент уехал вместе с вложенным контейнером: прокрутка любого контейнера — пересчёт в следующем кадре.
    // Верх элемента выше вьюпорта (-40), сам он ещё виден — кружок остался у верхнего края.
    form.getBoundingClientRect = () => ({ x: 10, y: -40, width: 300, height: 120, top: -40, left: 10, right: 310, bottom: 80, toJSON: () => ({}) });
    document.querySelector('main')?.dispatchEvent(new Event('scroll'));
    await nextFrame();
    expect(badge?.style.transform).toBe('translate3d(0px,0px,0)');
    form.getBoundingClientRect = () => ({ x: 10, y: -400, width: 300, height: 120, top: -400, left: 10, right: 310, bottom: -280, toJSON: () => ({}) });
    window.dispatchEvent(new Event('resize'));
    await nextFrame();
    expect(pins()).toBe(0);
  });

  it('протяжка больше 4 px — рамка: прямоугольник в координатах документа и до трёх элементов под центром', async () => {
    const picking = runScript();
    dispatchTrusted(button, mouse('mousedown', { clientX: 30, clientY: 30 }));
    dispatchTrusted(button, mouse('mousemove', { clientX: 100, clientY: 80 }));
    dispatchTrusted(button, mouse('mouseup', { clientX: 100, clientY: 80 }));
    const pick = (await picking) as Record<string, unknown>;
    expect(pick).toMatchObject({ kind: 'region', key: 'a1', rect: { x: 30, y: 30, width: 70, height: 50 }, anchor: { fx: 30 / window.innerWidth, fy: 30 / window.innerHeight } });
    expect((pick.elements as Array<{ selector: string }>).map((item) => item.selector)).toEqual(['button.save.primary', 'form#f', 'main.page']);
  });

  it('сдвиг не больше 4 px — это клик, а не рамка', async () => {
    const picking = runScript();
    dispatchTrusted(button, mouse('mousedown', { clientX: 30, clientY: 30 }));
    dispatchTrusted(button, mouse('mousemove', { clientX: 33, clientY: 32 }));
    dispatchTrusted(button, mouse('mouseup', { clientX: 33, clientY: 32 }));
    expect(((await picking) as { kind: string }).kind).toBe('element');
  });

  it('sync рисует номера и отдаёт доли вьюпорта; неизвестный ключ и пропавший элемент — null; count — только нарисованные; пусто — слой вынут', async () => {
    const picking = runScript();
    click(button);
    await picking;
    expect(controller().sync([{ n: 1, key: 'a1' }, { n: 2, key: 'a99' }])).toEqual([
      { n: 1, rect: { x: 10 / window.innerWidth, y: 20 / window.innerHeight, width: 300 / window.innerWidth, height: 120 / window.innerHeight } },
      { n: 2, rect: null },
    ]);
    expect(controller().count()).toBe(1);
    expect(pins()).toBe(1);
    form.remove();
    expect(controller().sync([{ n: 1, key: 'a1' }])).toEqual([{ n: 1, rect: null }]);
    expect(controller().count()).toBe(0);
    expect(pins()).toBe(0);
    controller().sync([]);
    expect(layer?.host.isConnected).toBe(false);
  });

  it('метка отдана — следующий жест гасится и ничего не ставит; клик по номеру готовой метки — правка', async () => {
    const first = runScript();
    click(button);
    await first;
    controller().sync([{ n: 1, key: 'a1' }]);
    click(button, 200, 200);
    expect(pageHandler).not.toHaveBeenCalled();
    expect(pins()).toBe(1);
    const second = runScript();
    // Номер метки 1 — кружок 24 px с центром в левом верхнем углу элемента (10, 20).
    click(button, 12, 22);
    expect(await second).toEqual({ kind: 'edit', n: 1 });
  });

  it('помеченный элемент скрыт display:none (вкладка, v-show, свёрнутый блок), но остался в DOM — как пропавший: rect null, не считается, номера нет; показан снова — метка на месте', async () => {
    const picking = runScript();
    click(button);
    await picking;
    const marks = [{ n: 1, key: 'a1' }];
    controller().sync(marks);
    expect(controller().count()).toBe(1);
    // display:none в Chromium: узел в документе (isConnected), коробок нет (getClientRects пуст), getBoundingClientRect — нули в (0, 0).
    form.getClientRects = () => [] as unknown as DOMRectList;
    form.getBoundingClientRect = () => domRect(0, 0, 0, 0);
    expect(controller().sync(marks)).toEqual([{ n: 1, rect: null }]);
    expect(controller().count()).toBe(0);
    expect(pins()).toBe(0);
    form.getClientRects = () => [domRect(10, 20, 300, 120)] as unknown as DOMRectList;
    form.getBoundingClientRect = () => domRect(10, 20, 300, 120);
    expect(controller().sync(marks)).toEqual([
      { n: 1, rect: { x: 10 / window.innerWidth, y: 20 / window.innerHeight, width: 300 / window.innerWidth, height: 120 / window.innerHeight } },
    ]);
    expect(controller().count()).toBe(1);
    expect(pins()).toBe(1);
  });

  it('угол вьюпорта (0, 0) — не номер скрытой метки: клик туда ставит новую, а не правит скрытую', async () => {
    const first = runScript();
    click(button);
    await first;
    controller().sync([{ n: 1, key: 'a1' }]);
    form.getClientRects = () => [] as unknown as DOMRectList;
    form.getBoundingClientRect = () => domRect(0, 0, 0, 0);
    const second = runScript();
    click(button, 3, 3);
    expect(await second).toMatchObject({ kind: 'element', key: 'a2' });
  });

  it('номер целиком во вьюпорте: у цели вплотную к краю кружок прижат внутрь, а не обрезан слоем; цель частично прокручена — номер у края', async () => {
    const picking = runScript();
    click(button);
    await picking;
    const marks = [{ n: 1, key: 'a1' }];
    /** Положение кружка метки 1 для элемента с таким прямоугольником. */
    const badgeFor = (rect: DOMRect): string | undefined => {
      form.getBoundingClientRect = () => rect;
      controller().sync(marks);
      return layer?.querySelector<HTMLElement>('[data-pin="1"]')?.style.transform;
    };
    // Шапка у левого верхнего угла: с центром на самом углу кружок ушёл бы за слой на три четверти, номера не видно.
    expect(badgeFor(domRect(0, 0, window.innerWidth, 60))).toBe('translate3d(0px,0px,0)');
    // Верх цели выше вьюпорта, сама она ещё видна: кружок у верхнего края, по горизонтали на своём месте.
    expect(badgeFor(domRect(100, -40, 300, 120))).toBe('translate3d(88px,0px,0)');
    // Угол цели у правого нижнего края вьюпорта: кружок целиком внутри.
    expect(badgeFor(domRect(window.innerWidth - 5, window.innerHeight - 5, 300, 120))).toBe(
      `translate3d(${window.innerWidth - 24}px,${window.innerHeight - 24}px,0)`,
    );
    // Цель в глубине вьюпорта — как прежде, центр кружка на её углу.
    expect(badgeFor(domRect(100, 200, 300, 120))).toBe('translate3d(88px,188px,0)');
  });

  it('клик попадает в номер там, где он нарисован: у прижатого к краю кружка — по кружку, а не по углу цели', async () => {
    const first = runScript();
    click(button);
    await first;
    form.getBoundingClientRect = () => domRect(0, 0, 300, 120);
    controller().sync([{ n: 1, key: 'a1' }]);
    // Кружок прижат к (0, 0)–(24, 24): точка (20, 20) в нём, хотя от угла цели дальше 12 px.
    const edit = runScript();
    click(button, 20, 20);
    expect(await edit).toEqual({ kind: 'edit', n: 1 });
    // Рядом с кружком — под ним, правее него и по диагонали — не номер, а новая метка.
    for (const [x, y] of [[10, 40], [40, 10], [30, 30]] as const) {
      const next = runScript();
      click(button, x, y);
      expect(await next, `${x},${y}`).toMatchObject({ kind: 'element' });
    }
    // Не у края кружок стоит вокруг угла цели (100, 200), то есть в (88, 188)–(112, 212): левее и выше него — не номер.
    form.getBoundingClientRect = () => domRect(100, 200, 300, 120);
    controller().sync([{ n: 1, key: 'a1' }]);
    for (const [x, y] of [[80, 200], [100, 180]] as const) {
      const next = runScript();
      click(button, x, y);
      expect(await next, `${x},${y}`).toMatchObject({ kind: 'element' });
    }
  });

  it('спрятанный номер (цель целиком за краем вьюпорта) не кликается: угол вьюпорта — не его кружок', async () => {
    const first = runScript();
    click(button);
    await first;
    form.getBoundingClientRect = () => domRect(0, -400, 300, 120);
    controller().sync([{ n: 1, key: 'a1' }]);
    expect(pins()).toBe(0);
    const second = runScript();
    click(button, 5, 5);
    expect(await second).toMatchObject({ kind: 'element', key: 'a2' });
  });

  it('Esc — null и режим выключен; недоверенные события ничего не ставят и не гасятся', async () => {
    const picking = runScript();
    let settled = false;
    void picking.then(() => {
      settled = true;
    });
    const fake = mouse('mousedown');
    button.dispatchEvent(fake);
    button.dispatchEvent(mouse('mouseup'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    expect(fake.defaultPrevented).toBe(false);
    expect(pageHandler).toHaveBeenCalledTimes(2);

    dispatchTrusted(document, new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(await picking).toBeNull();
    expect(controller().armed()).toBe(false);
  });

  it('pointerdown и pointerup страница не получает, но они не отменяются: иначе Chromium не пошлёт mousedown, mousemove и mouseup, и жест не начнётся (проба настоящего Electron)', async () => {
    const pagePointer = vi.fn();
    button.addEventListener('pointerdown', pagePointer);
    button.addEventListener('pointerup', pagePointer);
    const picking = runScript();
    const down = dispatchTrusted(button, mouse('pointerdown'));
    const up = dispatchTrusted(button, mouse('pointerup'));
    expect(pagePointer).not.toHaveBeenCalled();
    expect(down.defaultPrevented).toBe(false);
    expect(up.defaultPrevented).toBe(false);
    // click, как прежде, гасится: ссылка и кнопка страницы не срабатывают.
    expect(dispatchTrusted(button, mouse('click')).defaultPrevented).toBe(true);
    controller().cancel();
    await picking;
  });

  it('HTML метки — не длиннее CONTEXT_LIMITS.annotationHtml; обрезанный — на символ длиннее, так main видит обрезку', async () => {
    button.textContent = 'x'.repeat(5000);
    const picking = runScript();
    click(button);
    const pick = (await picking) as { html: string };
    expect(pick.html).toHaveLength(CONTEXT_LIMITS.annotationHtml + 1);
  });

  it('недоверенные click, pointerdown и Esc страницы доходят до неё, не гасятся, метку не ставят и режим не выключают', async () => {
    const pageSeen = vi.fn();
    for (const type of ['click', 'pointerdown', 'keydown']) button.addEventListener(type, pageSeen);
    const picking = runScript();
    let settled = false;
    void picking.then(() => {
      settled = true;
    });
    // Всё это страница делает сама (el.click(), dispatchEvent): метки ставит и режим выключает только человек.
    const fakes = [mouse('click'), mouse('pointerdown'), new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })];
    for (const fake of fakes) button.dispatchEvent(fake);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pageSeen).toHaveBeenCalledTimes(3);
    for (const fake of fakes) expect(fake.defaultPrevented, fake.type).toBe(false);
    expect(settled).toBe(false);
    expect(controller().waiting()).toBe(true);
    expect(controller().armed()).toBe(true);
  });

  it('недоверенный mousemove между mousedown и mouseup человека не делает из клика рамку', async () => {
    const picking = runScript();
    dispatchTrusted(button, mouse('mousedown', { clientX: 30, clientY: 30 }));
    button.dispatchEvent(mouse('mousemove', { clientX: 100, clientY: 80 }));
    dispatchTrusted(button, mouse('mouseup', { clientX: 31, clientY: 31 }));
    expect(((await picking) as { kind: string }).kind).toBe('element');
  });

  it.each([
    { how: 'Esc', leave: () => dispatchTrusted(document, new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) },
    { how: 'cancel()', leave: () => controller().cancel() },
  ])('после $how режим выключен: страница снова получает события человека, метки остались, а новый запуск с кликом ставит ещё одну', async ({ leave }) => {
    for (const type of ['click', 'pointerdown', 'keydown']) button.addEventListener(type, pageHandler);
    const first = runScript();
    click(button);
    await first;
    controller().sync([{ n: 1, key: 'a1' }]);
    const picking = runScript();
    leave();
    expect(await picking).toBeNull();
    expect(controller().armed()).toBe(false);
    // Режим выключен: всё, что делает человек, доходит до страницы и не отменяется.
    pageHandler.mockClear();
    const human = [mouse('mousedown'), mouse('mouseup'), mouse('click'), mouse('pointerdown'), new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })];
    for (const event of human) expect(dispatchTrusted(button, event).defaultPrevented, event.type).toBe(false);
    expect(pageHandler).toHaveBeenCalledTimes(human.length);
    // Метка на странице осталась; новый запуск и клик ставят следующую.
    expect(pins()).toBe(1);
    const again = runScript();
    click(button, 200, 200);
    expect(await again).toMatchObject({ kind: 'element', key: 'a2' });
    expect(pins()).toBe(2);
  });

  it('второй запуск — тот же объект: метки живут дольше вызова; новый pick отвечает прежнему null', async () => {
    const first = runScript();
    const ctrl = controller();
    const second = runScript();
    expect(controller()).toBe(ctrl);
    expect(await first).toBeNull();
    controller().cancel();
    expect(await second).toBeNull();
  });
});
