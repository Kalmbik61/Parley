/**
 * Палитры терминала по системной теме (кусок 1.3 плана окна, спека 4.7 —
 * значения таблицы дословно; сама таблица — из Orca
 * `src/renderer/src/lib/terminal-themes/defaults.ts`, коммит acf8e679).
 * Кусок 1 плана «Organic» (спека окна 2026-09-29, раздел 4 «Терминал»): фон, текст, курсор и
 * выделение — с листа окна, а 16 ANSI-цветов остались как есть. Терминал сидит на листе центра
 * (`--sheet`), и своего цвета у него нет: фон — `--sheet`, текст и курсор — `--color-text`, выделение —
 * `--color-accent` в 30 %. xterm не читает CSS-переменные, поэтому значения здесь — hex и `rgba()` тех
 * токенов; что они не разошлись с `styles/tokens.css`, держит `xterm-themes.test.ts`.
 * В отличие от прежней `xterm-theme.ts` (палитра TUI на восемь имён,
 * `config.theme`), тут ровно два варианта — тёмный и светлый — и переключение
 * идёт по `.dark` (`useUiStore`, кусок 1.1), а не по теме TUI: у окна теперь
 * своя системная тема, независимая от палитры терминала TUI (раздел 4.9 спеки).
 *
 * `cursorAccent` в таблице спеки не расписан отдельной строкой (там только
 * фон/текст/курсор), но в первоисточнике Orca он есть и равен фону — без
 * него курсор-блок рисуется с нечитаемым символом поверх себя же. Тут это
 * оставлено, как в первоисточнике: символ под курсором — цвета листа.
 */

import type { ITerminalOptions, ITheme } from '@xterm/xterm';

/** ANSI — Ghostty Default Style Dark (спека Orca-UI 4.7); остальное — лист тёмной темы Organic. */
export const XTERM_DARK: ITheme = {
  background: '#0b0a09',
  foreground: '#ece6dc',
  cursor: '#ece6dc',
  cursorAccent: '#0b0a09',
  selectionBackground: 'rgba(214, 127, 72, 0.3)',
  black: '#1d1f21',
  red: '#cc6666',
  green: '#b5bd68',
  yellow: '#f0c674',
  blue: '#81a2be',
  magenta: '#b294bb',
  cyan: '#8abeb7',
  white: '#c5c8c6',
  brightBlack: '#666666',
  brightRed: '#d54e53',
  brightGreen: '#b9ca4a',
  brightYellow: '#e7c547',
  brightBlue: '#7aa6da',
  brightMagenta: '#c397d8',
  brightCyan: '#70c0b1',
  brightWhite: '#eaeaea',
};

/** ANSI — Builtin Tango Light (спека Orca-UI 4.7); остальное — лист светлой темы Organic. */
export const XTERM_LIGHT: ITheme = {
  background: '#f9f4ed',
  foreground: '#201e1d',
  cursor: '#201e1d',
  cursorAccent: '#f9f4ed',
  selectionBackground: 'rgba(198, 113, 57, 0.3)',
  black: '#2e3436',
  red: '#cc0000',
  green: '#4e9a06',
  yellow: '#8e7700',
  blue: '#3465a4',
  magenta: '#75507b',
  cyan: '#05727e',
  white: '#6a6a6a',
  brightBlack: '#555753',
  brightRed: '#ef2929',
  brightGreen: '#1b7a1b',
  brightYellow: '#6d5a00',
  brightBlue: '#204a87',
  brightMagenta: '#ad7fa8',
  brightCyan: '#034b50',
  brightWhite: '#3d3d3d',
};

export function xtermTheme(dark: boolean): ITheme {
  return dark ? XTERM_DARK : XTERM_LIGHT;
}

/** Параметры терминала, общие для обеих тем — спека 4.3/4.7. */
export const XTERM_OPTIONS: Pick<
  ITerminalOptions,
  | 'lineHeight'
  | 'fontWeight'
  | 'fontWeightBold'
  | 'scrollback'
  | 'cursorStyle'
  | 'cursorBlink'
  | 'cursorInactiveStyle'
> = {
  lineHeight: 1,
  fontWeight: 500,
  fontWeightBold: 700,
  scrollback: 5000,
  cursorStyle: 'block',
  cursorBlink: true,
  cursorInactiveStyle: 'outline',
};

/** В светлой теме — 4.5, в тёмной — 1 (по умолчанию xterm). Спека 4.7. */
export function minimumContrastRatio(dark: boolean): number {
  return dark ? 1 : 4.5;
}
