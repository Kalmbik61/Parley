// packages/desktop/src/main/browser/page-fns.test.ts
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { HIT_TEST_FN, PAGE_FNS, SELECT_OPTION_FN } from './page-fns.js';
import { REACT_INFO_FN } from './react-info.js';

type SelectFn = (this: unknown, wanted: string) => { ok: boolean; label?: string; options?: string[] };
const fn = new Function(`return (${SELECT_OPTION_FN});`)() as SelectFn;

function select(options: Array<[string, string]>): HTMLSelectElement {
  const el = document.createElement('select');
  for (const [value, text] of options) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    el.append(option);
  }
  return el;
}

describe('SELECT_OPTION_FN (функция Parley в мире страницы)', () => {
  it('выбирает по тексту, шлёт input и change по разу', () => {
    const el = select([['red', 'Red'], ['blue', 'Blue']]);
    document.body.append(el);
    const input = vi.fn();
    const change = vi.fn();
    document.body.addEventListener('input', input);
    document.body.addEventListener('change', change);
    expect(fn.call(el, 'Blue')).toEqual({ ok: true, label: 'Blue' });
    expect(el.value).toBe('blue');
    expect(input).toHaveBeenCalledTimes(1);
    expect(change).toHaveBeenCalledTimes(1);
  });

  it('выбирает по value', () => {
    const el = select([['red', 'Red'], ['blue', 'Blue']]);
    expect(fn.call(el, 'blue')).toEqual({ ok: true, label: 'Blue' });
  });

  it('нет такого варианта — список вариантов, значение прежнее', () => {
    const el = select([['red', 'Red'], ['blue', 'Blue']]);
    expect(fn.call(el, 'green')).toEqual({ ok: false, options: ['Red', 'Blue'] });
    expect(el.value).toBe('red');
  });

  it('не <select> — пустой список', () => {
    expect(fn.call(document.createElement('div'), 'x')).toEqual({ ok: false, options: [] });
  });

  it('вариантов в ответе не больше 50', () => {
    const el = select(Array.from({ length: 80 }, (_, i): [string, string] => [`v${i}`, `Option ${i}`]));
    expect(fn.call(el, 'nope').options).toHaveLength(50);
  });

  it('PAGE_FNS — три функции Parley', () => {
    expect(PAGE_FNS.has(SELECT_OPTION_FN)).toBe(true);
    expect(PAGE_FNS.has(REACT_INFO_FN)).toBe(true);
    expect(PAGE_FNS.has(HIT_TEST_FN)).toBe(true);
    expect(PAGE_FNS.size).toBe(3);
  });
});

type HitFn = (this: unknown, recenter: boolean) => { covered: boolean; by?: string };
const hit = new Function(`return (${HIT_TEST_FN});`)() as HitFn;

/** Цель с рамкой 100×40 в (0, 0): центр (50, 20); `top` — что вернёт `elementFromPoint` документа. */
function target(top: (el: HTMLElement) => Element | null, rect = { width: 100, height: 40 }): HTMLElement {
  const el = document.createElement('button');
  document.body.append(el);
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: rect.width, height: rect.height, right: rect.width, bottom: rect.height, x: 0, y: 0 }) as DOMRect;
  document.elementFromPoint = vi.fn(() => top(el));
  return el;
}

describe('HIT_TEST_FN (проверка перекрытия перед кликом)', () => {
  it('верхний элемент — сама цель или её потомок: не перекрыта', () => {
    const own = target((el) => el);
    expect(hit.call(own, false)).toEqual({ covered: false });
    const child = target((el) => el.appendChild(document.createElement('span')));
    expect(hit.call(child, false)).toEqual({ covered: false });
  });

  it('верхний — чужой диалог: перекрыта, описание — тег, роль и текст', () => {
    const el = target(() => {
      const dialog = document.createElement('div');
      dialog.setAttribute('role', 'dialog');
      dialog.textContent = '  Cookie   consent ';
      return dialog;
    });
    expect(hit.call(el, false)).toEqual({ covered: true, by: 'div[role=dialog] "Cookie consent"' });
  });

  it('верхний — <label> поля-цели (скрытый флажок под подписью): не перекрыта', () => {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.id = 'cb';
    const label = document.createElement('label');
    label.htmlFor = 'cb';
    document.body.append(box, label);
    box.getBoundingClientRect = () => ({ left: 0, top: 0, width: 10, height: 10 }) as DOMRect;
    document.elementFromPoint = vi.fn(() => label);
    expect(hit.call(box, false)).toEqual({ covered: false });
  });

  it('верхний — предок цели: не перекрыта', () => {
    const el = target(() => document.body);
    expect(hit.call(el, false)).toEqual({ covered: false });
  });

  it('рамка нулевого размера и точка вне страницы (elementFromPoint даёт null): не перекрыта', () => {
    const flat = target(() => document.createElement('div'), { width: 0, height: 0 });
    expect(hit.call(flat, false)).toEqual({ covered: false });
    const outside = target(() => null);
    expect(hit.call(outside, false)).toEqual({ covered: false });
  });

  it('цель внутри открытого теневого корня: спрашивает корень, свой элемент — не перекрыта', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const inner = document.createElement('button');
    shadow.append(inner);
    inner.getBoundingClientRect = () => ({ left: 0, top: 0, width: 10, height: 10 }) as DOMRect;
    (shadow as unknown as { elementFromPoint: (x: number, y: number) => Element | null }).elementFromPoint = vi.fn(() => inner);
    expect(hit.call(inner, false)).toEqual({ covered: false });
  });

  it('recenter: true прокручивает цель в середину вьюпорта, false — нет', () => {
    const el = target((own) => own);
    const scroll = vi.fn();
    el.scrollIntoView = scroll;
    hit.call(el, false);
    expect(scroll).not.toHaveBeenCalled();
    hit.call(el, true);
    expect(scroll).toHaveBeenCalledWith({ block: 'center', inline: 'center' });
  });

  it('текст перекрывающего элемента режется до 60 знаков; aria-label главнее текста', () => {
    const long = target(() => Object.assign(document.createElement('div'), { textContent: 'x'.repeat(100) }));
    expect(hit.call(long, false).by).toBe(`div "${'x'.repeat(60)}"`);
    const named = target(() => {
      const div = document.createElement('div');
      div.setAttribute('aria-label', 'Close banner');
      div.textContent = 'ignored';
      return div;
    });
    expect(hit.call(named, false).by).toBe('div "Close banner"');
  });
});
