/**
 * Разбор `tokens.css` для тестов контраста (кусок 1 плана «Organic»): переменные shadcn теперь
 * выражены через палитру — `var()` и `color-mix()`, — поэтому тест сам разворачивает их так же,
 * как браузер, а не держит вторую копию hex-значений.
 */

import { describe, expect, it } from 'vitest';
import { colorOver, parseThemeInline, parseTokens, rawValue, resolveColor, substituted } from './css-tokens.js';

const CSS = `
  /* комментарий с { скобкой и --fake: #000000; */
  @theme inline { --color-primary: var(--primary); }
  @theme static { --color-ink-100: #f9f4ed; --color-ink-900: #2e2b25; }
  :root {
    --color-bg: #fff;
    --color-text: rgb(32 30 29);
    --color-accent: #c67139;
    --color-divider: color-mix(in srgb, #201e1d 16%, transparent);
    --primary: var(--color-accent);
    --soft: color-mix(in srgb, var(--color-text) 9%, transparent);
    --mixed: color-mix(in srgb, #000000 25%, #ffffff);
    --half: rgb(0 0 0 / .5);
    --loop-a: var(--loop-b);
    --loop-b: var(--loop-a);
    --fallback: var(--nope, #123456);
  }
  .dark {
    --color-bg: #0e0d0c;
    --color-accent: #d67f48;
  }
`;

describe('parseTokens и rawValue', () => {
  const tokens = parseTokens(CSS);

  it('светлая тема — @theme static и :root; @theme inline и комментарии не читаются', () => {
    expect(rawValue(tokens, 'light', '--color-ink-100')).toBe('#f9f4ed');
    expect(rawValue(tokens, 'light', '--color-bg')).toBe('#fff');
    expect(() => rawValue(tokens, 'light', '--color-primary')).toThrow(/не найден/);
    expect(() => rawValue(tokens, 'light', '--fake')).toThrow(/не найден/);
  });

  it('тёмная — светлая, поверх которой .dark переопределяет только своё', () => {
    expect(rawValue(tokens, 'dark', '--color-bg')).toBe('#0e0d0c');
    expect(rawValue(tokens, 'dark', '--color-ink-100')).toBe('#f9f4ed');
  });
});

describe('resolveColor', () => {
  const tokens = parseTokens(CSS);

  it('hex, rgb() и alpha в rgb()', () => {
    expect(resolveColor(tokens, 'light', '--color-bg')).toEqual({ rgb: [255, 255, 255], alpha: 1 });
    expect(resolveColor(tokens, 'light', '--color-text')).toEqual({ rgb: [32, 30, 29], alpha: 1 });
    expect(resolveColor(tokens, 'light', '--half')).toEqual({ rgb: [0, 0, 0], alpha: 0.5 });
  });

  it('var() подставляется по теме: --primary в тёмной берёт тёмный --color-accent', () => {
    expect(resolveColor(tokens, 'light', '--primary').rgb).toEqual([0xc6, 0x71, 0x39]);
    expect(resolveColor(tokens, 'dark', '--primary').rgb).toEqual([0xd6, 0x7f, 0x48]);
  });

  it('запасное значение var() берётся, если переменной нет', () => {
    expect(resolveColor(tokens, 'light', '--fallback').rgb).toEqual([0x12, 0x34, 0x56]);
  });

  it('color-mix(in srgb, X N%, transparent) — тот же цвет с прозрачностью N%', () => {
    const divider = resolveColor(tokens, 'light', '--color-divider');
    expect(divider.rgb).toEqual([0x20, 0x1e, 0x1d]);
    expect(divider.alpha).toBe(0.16);
    expect(resolveColor(tokens, 'light', '--soft').alpha).toBeCloseTo(0.09, 10);
  });

  it('color-mix двух непрозрачных цветов — обычное смешение', () => {
    const mixed = resolveColor(tokens, 'light', '--mixed');
    expect(mixed.alpha).toBe(1);
    expect(mixed.rgb[0]).toBeCloseTo(0.25 * 0 + 0.75 * 255, 6);
  });

  it('цикл переменных и неизвестная запись — понятная ошибка, а не молчаливый ноль', () => {
    expect(() => resolveColor(tokens, 'light', '--loop-a')).toThrow(/цикл/);
    expect(() => resolveColor(tokens, 'light', '--nope')).toThrow(/не найден/);
  });
});

describe('colorOver', () => {
  const tokens = parseTokens(CSS);

  it('непрозрачный — как есть, прозрачный — поверх подложки, целыми каналами (пиксель на экране)', () => {
    expect(colorOver(tokens, 'light', '--color-bg', [0, 0, 0])).toEqual([255, 255, 255]);
    // 9 % (32,30,29) поверх белого: 255 − 0.09 × (255 − c) = 234.9 / 234.8 / 234.7 → 235
    expect(colorOver(tokens, 'light', '--soft', [255, 255, 255])).toEqual([235, 235, 235]);
  });
});

describe('substituted', () => {
  const tokens = parseTokens(CSS);

  it('цепочка var(--a) → var(--b) → значение — то, что вернёт getPropertyValue после подстановки', () => {
    expect(substituted(tokens, 'light', '--primary')).toBe('#c67139');
    expect(substituted(tokens, 'dark', '--primary')).toBe('#d67f48');
  });

  it('значение не из одного var() остаётся как написано', () => {
    expect(substituted(tokens, 'light', '--color-divider')).toBe('color-mix(in srgb, #201e1d 16%, transparent)');
  });
});

describe('parseThemeInline', () => {
  it('имя утилиты → выражение блока @theme inline', () => {
    expect(parseThemeInline(CSS)).toEqual(new Map([['--color-primary', 'var(--primary)']]));
  });
});
