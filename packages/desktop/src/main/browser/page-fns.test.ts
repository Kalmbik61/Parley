// packages/desktop/src/main/browser/page-fns.test.ts
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { PAGE_FNS, SELECT_OPTION_FN } from './page-fns.js';
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

  it('PAGE_FNS — обе функции Parley', () => {
    expect(PAGE_FNS.has(SELECT_OPTION_FN)).toBe(true);
    expect(PAGE_FNS.has(REACT_INFO_FN)).toBe(true);
    expect(PAGE_FNS.size).toBe(2);
  });
});
