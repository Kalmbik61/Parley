// @vitest-environment jsdom
// vitest.config.ts даёт src/main/** среду node, а скрипт выбора живёт в странице — ему нужен DOM.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Путь, а не URL: в jsdom глобальный URL — его, и readFileSync такой не примет.
const here = path.dirname(fileURLToPath(import.meta.url));
const guestScript = readFileSync(path.join(here, 'guest-pick.js'), 'utf8');
const domScript = readFileSync(path.join(here, 'guest-dom.js'), 'utf8');

/**
 * isTrusted у jsdom — неподделываемое свойство (как в браузере), а dispatchEvent сбрасывает его в
 * false. «Действие человека» тест делает, как сама jsdom шлёт доверенные события: флаг у события
 * и внутренний _dispatch цели. Иначе проверить «недоверенное не выбирает» было бы не с чем сравнить.
 */
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

/** Скрипт как в госте: помощники DOM и скрипт выбора одной строкой, её значение — промис выбора. */
function runScript(): Promise<unknown> {
  return (0, eval)(`${domScript}\n${guestScript}`) as Promise<unknown>;
}

describe('guest-pick.js в jsdom (тест 3 куска 9.3a)', () => {
  let form: HTMLFormElement;
  let button: HTMLButtonElement;
  const pageHandlers = { onclick: vi.fn(), pointerup: vi.fn(), mouseup: vi.fn(), dblclick: vi.fn(), click: vi.fn() };

  beforeEach(() => {
    document.body.innerHTML = `
      <main class="page">
        <form class="login" id="f">
          <input type="password" value="secret">
          <input type="hidden" name="csrf" value="tok">
          <input autocomplete="cc-number" value="4111">
          <input autocomplete="section-a new-password" value="pw2">
          <input type="text" name="nick" value="visible">
          <script>window.leak = 1</script>
          <style>.x { color: red }</style>
          <div srcdoc="leak-srcdoc" onmouseover="leak()">frame</div>
          <button class="save primary" type="button" onclick="window.leak = 2">Save</button>
        </form>
      </main>`;
    form = document.querySelector('form') as HTMLFormElement;
    button = document.querySelector('button') as HTMLButtonElement;
    for (const handler of Object.values(pageHandlers)) handler.mockClear();
    button.onclick = pageHandlers.onclick;
    button.addEventListener('pointerup', pageHandlers.pointerup);
    button.addEventListener('mouseup', pageHandlers.mouseup);
    button.addEventListener('dblclick', pageHandlers.dblclick);
    button.addEventListener('click', pageHandlers.click);

    // Чего нет в jsdom: скрипт читает это через document и элемент, как в браузере.
    document.elementFromPoint = vi.fn(() => form);
    Object.defineProperty(HTMLElement.prototype, 'innerText', {
      configurable: true,
      get(this: HTMLElement) {
        return this.textContent ?? '';
      },
    });
    HTMLElement.prototype.scrollIntoView = vi.fn();
    form.getBoundingClientRect = () => ({ x: 10, y: 20, width: 300, height: 120, top: 20, left: 10, right: 310, bottom: 140, toJSON: () => ({}) });
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('клик человека: данные элемента, секреты полей вырезаны, клик до страницы не дошёл', async () => {
    const picking = runScript();

    dispatchTrusted(button, mouse('mousemove'));
    // Оверлей: подпись `tag.class · W×H` над элементом под курсором.
    expect(document.documentElement.textContent).toContain('form.login · 300×120');

    // dblclick прошлого клика — до выбора: тоже гасится.
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'dblclick', 'auxclick', 'contextmenu']) {
      const event = type.startsWith('pointer') ? new PointerEvent(type, { bubbles: true, cancelable: true }) : mouse(type);
      dispatchTrusted(button, event);
      expect(event.defaultPrevented, type).toBe(true);
    }
    const click = dispatchTrusted(button, mouse('click'));
    expect(click.defaultPrevented).toBe(true);

    const result = (await picking) as Record<string, unknown>;
    for (const handler of Object.values(pageHandlers)) expect(handler).not.toHaveBeenCalled();

    const html = String(result.html);
    expect(html).toContain('<input');
    expect(html).toContain('visible');
    for (const secret of ['secret', 'tok', '4111', 'pw2']) expect(html).not.toContain(secret);
    expect(html).not.toMatch(/onclick|onmouseover|srcdoc|<script|<style/i);

    // Кратчайший уникальный селектор (guest-dom.js, по Orca): у формы есть id.
    expect(result.selector).toBe('form#f');
    expect(result.text).toMatch(/frame Save$/);
    expect(result.rect).toEqual({ x: 10, y: 20, width: 300, height: 120 });
    expect(result.viewport).toEqual({ width: window.innerWidth, height: window.innerHeight });
    expect(result.styles).toMatchObject({ display: 'block' });
    expect(result).toHaveProperty('devicePixelRatio');
    // Этап B: точка для CDP — сам клик (под ним выбранный элемент), без ⇧, прокрутка документа.
    expect(result.point).toEqual({ x: 30, y: 30 });
    expect(result.shift).toBe(false);
    expect(result.scroll).toEqual({ x: 0, y: 0 });

    // Оверлей и перехватчики сняты: клик снова доходит до страницы.
    expect(document.documentElement.textContent).not.toContain('form.login ·');
    dispatchTrusted(button, mouse('click'));
    expect(pageHandlers.onclick).toHaveBeenCalledTimes(1);
  });

  it('событие с isTrusted: false ничего не выбирает и не гасится; Esc — null', async () => {
    const picking = runScript();
    let settled = false;
    void picking.then(() => {
      settled = true;
    });

    const fake = mouse('click');
    button.dispatchEvent(fake);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);
    expect(fake.defaultPrevented).toBe(false);
    expect(pageHandlers.onclick).toHaveBeenCalledTimes(1);

    // Недоверенный Esc тоже не в счёт.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);

    dispatchTrusted(document, new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(await picking).toBeNull();
  });

  it('элемент вне видимой области прокручивается к центру', async () => {
    let top = 5000;
    form.getBoundingClientRect = () => ({ x: 10, y: top, width: 300, height: 120, top, left: 10, right: 310, bottom: top + 120, toJSON: () => ({}) });
    form.scrollIntoView = vi.fn(() => {
      top = 100;
    });
    const picking = runScript();
    dispatchTrusted(button, mouse('click'));
    const result = (await picking) as { rect: { y: number }; point: unknown };
    expect(form.scrollIntoView).toHaveBeenCalledWith({ block: 'center', inline: 'center', behavior: 'instant' });
    expect(result.rect.y).toBe(100);
    expect(result.point).toEqual({ x: 160, y: 160 });
  });

  it('⇧-клик — shift: true (Select держит режим, спека браузера 4.6)', async () => {
    const picking = runScript();
    dispatchTrusted(button, mouse('click', { shiftKey: true }));
    expect(((await picking) as { shift: boolean }).shift).toBe(true);
  });

  it('после прокрутки под центром другой узел — точки нет', async () => {
    let top = 5000;
    form.getBoundingClientRect = () => ({ x: 10, y: top, width: 300, height: 120, top, left: 10, right: 310, bottom: top + 120, toJSON: () => ({}) });
    form.scrollIntoView = vi.fn(() => {
      top = 100;
    });
    document.elementFromPoint = vi.fn((x: number) => (x === 30 ? form : button));
    const picking = runScript();
    dispatchTrusted(button, mouse('click'));
    expect(((await picking) as { point: unknown }).point).toBeNull();
  });

  it('центр элемента за краем окна (он шире и выше окна) — точка прижата к видимой части', async () => {
    form.getBoundingClientRect = () => ({ x: 10, y: 100, width: 3000, height: 4000, top: 100, left: 10, right: 3010, bottom: 4100, toJSON: () => ({}) });
    const picking = runScript();
    dispatchTrusted(button, mouse('click'));
    // Окно jsdom 1024×768: центр элемента (1510; 2100) прижимается к последнему столбцу и последней строке окна.
    expect(((await picking) as { point: unknown }).point).toEqual({ x: window.innerWidth - 1, y: window.innerHeight - 1 });
  });

  it('прокрутка документа — в результате: точка документа для CDP = точка вьюпорта + прокрутка', async () => {
    const scrollX = Object.getOwnPropertyDescriptor(window, 'scrollX');
    const scrollY = Object.getOwnPropertyDescriptor(window, 'scrollY');
    Object.defineProperty(window, 'scrollX', { configurable: true, value: 5 });
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 250 });
    try {
      const picking = runScript();
      dispatchTrusted(button, mouse('click'));
      expect(((await picking) as { scroll: unknown }).scroll).toEqual({ x: 5, y: 250 });
    } finally {
      if (scrollX !== undefined) Object.defineProperty(window, 'scrollX', scrollX);
      if (scrollY !== undefined) Object.defineProperty(window, 'scrollY', scrollY);
    }
  });

  it('новый запуск снимает прежний выбор (null), отмена мира — тоже', async () => {
    const first = runScript();
    const second = runScript();
    expect(await first).toBeNull();
    (globalThis as { __parleyPickCancel?: () => void }).__parleyPickCancel?.();
    expect(await second).toBeNull();
  });
});
