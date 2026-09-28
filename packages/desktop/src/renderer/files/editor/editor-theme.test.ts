/**
 * Тема Monaco из токенов окна (раунд fix-7.3b, ревью 7.3b-B, Critical): сжатый сборкой `#fff`
 * ронял редактор в светлой теме — короткий hex разворачивается, сбой темы не роняет редактор.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyTheme, tokenColor, type ThemeApi } from './editor-theme.js';

function styleOf(vars: Record<string, string>): CSSStyleDeclaration {
  return { getPropertyValue: (name: string) => vars[name] ?? '' } as unknown as CSSStyleDeclaration;
}

describe('tokenColor', () => {
  it('разворачивает короткий hex, полный оставляет', () => {
    expect(tokenColor('#fff', '#000000')).toBe('#ffffff');
    expect(tokenColor(' #abcd ', '#000000')).toBe('#aabbccdd');
    expect(tokenColor('#1e1e1e', '#000000')).toBe('#1e1e1e');
    expect(tokenColor('#264f78cc', '#000000')).toBe('#264f78cc');
  });

  it('не hex и неполный hex — запасной', () => {
    expect(tokenColor('rgb(255, 255, 255)', '#0a0a0a')).toBe('#0a0a0a');
    expect(tokenColor('', '#0a0a0a')).toBe('#0a0a0a');
    expect(tokenColor('#fffff', '#0a0a0a')).toBe('#0a0a0a');
  });
});

describe('applyTheme', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('светлая тема из сжатых токенов — полный hex и своя тема', () => {
    const api: ThemeApi = { defineTheme: vi.fn(), setTheme: vi.fn() };
    applyTheme(api, false, styleOf({ '--editor-surface': '#fff', '--foreground': '#0a0a0a' }));
    expect(api.defineTheme).toHaveBeenCalledWith(
      'harnas-light',
      expect.objectContaining({ base: 'vs', colors: expect.objectContaining({ 'editor.background': '#ffffff', 'editor.foreground': '#0a0a0a' }) }),
    );
    expect(api.setTheme).toHaveBeenCalledWith('harnas-light');
  });

  it.each([
    [false, 'vs'],
    [true, 'vs-dark'],
  ] as const)('сбой defineTheme (dark=%s) — предупреждение и встроенная %s, без исключения', (dark, builtin) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const api: ThemeApi = {
      defineTheme: () => {
        throw new Error('Illegal value for token color: #fff');
      },
      setTheme: vi.fn(),
    };
    expect(() => applyTheme(api, dark, styleOf({}))).not.toThrow();
    expect(api.setTheme).toHaveBeenCalledWith(builtin);
    expect(warn).toHaveBeenCalledWith('[harnas] monaco theme', expect.any(Error));
  });

  it('сбой setTheme своей темы — встроенная', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const setTheme = vi.fn((name: string) => {
      if (name === 'harnas-dark') throw new Error('bad theme');
    });
    applyTheme({ defineTheme: vi.fn(), setTheme }, true, styleOf({}));
    expect(setTheme.mock.calls.map(([name]) => name)).toEqual(['harnas-dark', 'vs-dark']);
  });
});
