/**
 * Палитра → тема xterm (кусок 1.11 плана окна). xterm красит канвой/WebGL
 * напрямую и не видит CSS-переменные `apply-theme.ts` — ему нужны сами
 * hex-значения. У палитры (`theme/palettes.ts`) нет отдельных «ярких»
 * цветов — используем те же самые: полужирное начертание в терминале и так
 * видно по шрифту, заводить вторую восьмёрку цветов не для чего.
 */

import type { ITheme } from '@xterm/xterm';
import { resolvePalette } from '../../theme/apply-theme.js';
import type { Palette } from '../../theme/palettes.js';

export function paletteToXtermTheme(palette: Palette): ITheme {
  return {
    background: palette.base,
    foreground: palette.text,
    cursor: palette.text,
    cursorAccent: palette.base,
    selectionBackground: palette.selection,
    black: palette.crust,
    red: palette.red,
    green: palette.green,
    yellow: palette.yellow,
    blue: palette.blue,
    magenta: palette.magenta,
    cyan: palette.cyan,
    white: palette.subtext,
    brightBlack: palette.overlay,
    brightRed: palette.red,
    brightGreen: palette.green,
    brightYellow: palette.yellow,
    brightBlue: palette.blue,
    brightMagenta: palette.magenta,
    brightCyan: palette.cyan,
    brightWhite: palette.text,
  };
}

/** То же, что `paletteToXtermTheme(resolvePalette(themeName))` — неизвестное имя (включая `terminal`) уходит в `mocha`, как и остальное окно. */
export function themeNameToXtermTheme(themeName: string): ITheme {
  return paletteToXtermTheme(resolvePalette(themeName));
}
