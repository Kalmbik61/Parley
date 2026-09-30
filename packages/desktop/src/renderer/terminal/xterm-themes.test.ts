/**
 * Тест 1 куска 1.3 плана окна: 16 ANSI-цветов каждой темы — дословно по таблице спеки Orca-UI 4.7
 * (сама таблица — из Orca `src/renderer/src/lib/terminal-themes/defaults.ts`, коммит acf8e679).
 * Кусок 1 плана «Organic»: фон, текст, курсор и выделение — с листа окна (спека окна 2026-09-29,
 * раздел 4 «Терминал»), значения сверяются с `styles/tokens.css`, а не с копией в тесте.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../test-utils/contrast.js';
import { parseTokens, resolveColor, type Theme } from '../test-utils/css-tokens.js';
import { minimumContrastRatio, XTERM_DARK, XTERM_LIGHT, XTERM_OPTIONS, xtermTheme } from './xterm-themes.js';

const tokens = parseTokens(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'styles', 'tokens.css'), 'utf8'));

/** Цвет токена как `#rrggbb` — так пишет тему терминала код. */
function hex(theme: Theme, name: string): string {
  return `#${resolveColor(tokens, theme, name).rgb.map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;
}

/** Акцент палитры в 30 % — `rgba()`, который xterm понимает и с альфой (выделение может быть прозрачным). */
function accent30(theme: Theme): string {
  const [r, g, b] = resolveColor(tokens, theme, '--color-accent').rgb.map(Math.round);
  return `rgba(${r}, ${g}, ${b}, 0.3)`;
}

describe('XTERM_DARK / XTERM_LIGHT — фон, текст, курсор и выделение с листа окна (Organic)', () => {
  for (const [theme, xterm] of [
    ['light', XTERM_LIGHT],
    ['dark', XTERM_DARK],
  ] as const) {
    it(`${theme}: фон — --sheet, текст и курсор — --color-text, символ под курсором-блоком — фон листа`, () => {
      expect(xterm.background).toBe(hex(theme, '--sheet'));
      expect(xterm.foreground).toBe(hex(theme, '--color-text'));
      expect(xterm.cursor).toBe(hex(theme, '--color-text'));
      expect(xterm.cursorAccent).toBe(hex(theme, '--sheet'));
    });

    it(`${theme}: выделение — accent 30 %`, () => {
      expect(xterm.selectionBackground).toBe(accent30(theme));
    });

    it(`${theme}: текст на фоне терминала — не ниже 4.5:1`, () => {
      const ratio = contrastRatio(resolveColor(tokens, theme, '--color-text').rgb, resolveColor(tokens, theme, '--sheet').rgb);
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe('XTERM_DARK / XTERM_LIGHT — ANSI-палитры, спека Orca-UI 4.7, таблица дословно', () => {

  it('16 ANSI-цветов тёмной темы (Ghostty Default Style Dark)', () => {
    expect([
      XTERM_DARK.black,
      XTERM_DARK.red,
      XTERM_DARK.green,
      XTERM_DARK.yellow,
      XTERM_DARK.blue,
      XTERM_DARK.magenta,
      XTERM_DARK.cyan,
      XTERM_DARK.white,
    ]).toEqual(['#1d1f21', '#cc6666', '#b5bd68', '#f0c674', '#81a2be', '#b294bb', '#8abeb7', '#c5c8c6']);
    expect([
      XTERM_DARK.brightBlack,
      XTERM_DARK.brightRed,
      XTERM_DARK.brightGreen,
      XTERM_DARK.brightYellow,
      XTERM_DARK.brightBlue,
      XTERM_DARK.brightMagenta,
      XTERM_DARK.brightCyan,
      XTERM_DARK.brightWhite,
    ]).toEqual(['#666666', '#d54e53', '#b9ca4a', '#e7c547', '#7aa6da', '#c397d8', '#70c0b1', '#eaeaea']);
  });

  it('16 ANSI-цветов светлой темы (Builtin Tango Light)', () => {
    expect([
      XTERM_LIGHT.black,
      XTERM_LIGHT.red,
      XTERM_LIGHT.green,
      XTERM_LIGHT.yellow,
      XTERM_LIGHT.blue,
      XTERM_LIGHT.magenta,
      XTERM_LIGHT.cyan,
      XTERM_LIGHT.white,
    ]).toEqual(['#2e3436', '#cc0000', '#4e9a06', '#8e7700', '#3465a4', '#75507b', '#05727e', '#6a6a6a']);
    expect([
      XTERM_LIGHT.brightBlack,
      XTERM_LIGHT.brightRed,
      XTERM_LIGHT.brightGreen,
      XTERM_LIGHT.brightYellow,
      XTERM_LIGHT.brightBlue,
      XTERM_LIGHT.brightMagenta,
      XTERM_LIGHT.brightCyan,
      XTERM_LIGHT.brightWhite,
    ]).toEqual(['#555753', '#ef2929', '#1b7a1b', '#6d5a00', '#204a87', '#ad7fa8', '#034b50', '#3d3d3d']);
  });
});

describe('xtermTheme', () => {
  it('true → XTERM_DARK, false → XTERM_LIGHT', () => {
    expect(xtermTheme(true)).toBe(XTERM_DARK);
    expect(xtermTheme(false)).toBe(XTERM_LIGHT);
  });
});

describe('minimumContrastRatio — спека 4.7', () => {
  it('светлая тема — 4.5', () => {
    expect(minimumContrastRatio(false)).toBe(4.5);
  });

  it('тёмная тема — 1 (умолчание xterm)', () => {
    expect(minimumContrastRatio(true)).toBe(1);
  });
});

describe('XTERM_OPTIONS — спека 4.3/4.7', () => {
  it('значения интерфейса куска дословно', () => {
    expect(XTERM_OPTIONS).toEqual({
      lineHeight: 1,
      fontWeight: 500,
      fontWeightBold: 700,
      scrollback: 5000,
      cursorStyle: 'block',
      cursorBlink: true,
      cursorInactiveStyle: 'outline',
    });
  });
});
