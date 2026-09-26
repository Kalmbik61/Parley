import { describe, expect, it } from 'vitest';
import { applyTheme, resolvePalette } from './apply-theme.js';
import { PALETTES } from './palettes.js';

describe('resolvePalette', () => {
  it('известное имя — своя палитра', () => {
    expect(resolvePalette('nord')).toBe(PALETTES.nord);
  });

  it('terminal — показывается как mocha', () => {
    expect(resolvePalette('terminal')).toBe(PALETTES.mocha);
  });

  it('неизвестное имя — тоже mocha, а не падение', () => {
    expect(resolvePalette('неон')).toBe(PALETTES.mocha);
  });
});

describe('applyTheme', () => {
  it('пишет CSS-переменные и kind на переданный корень', () => {
    const root = document.createElement('html');
    applyTheme('gruvbox', root);

    expect(root.style.getPropertyValue('--h-base')).toBe(PALETTES.gruvbox.base);
    expect(root.style.getPropertyValue('--h-cyan')).toBe(PALETTES.gruvbox.cyan);
    expect(root.dataset.themeKind).toBe('dark');
  });

  it('latte — светлая тема', () => {
    const root = document.createElement('html');
    applyTheme('latte', root);
    expect(root.dataset.themeKind).toBe('light');
  });
});
