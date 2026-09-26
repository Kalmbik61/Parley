/**
 * Применяет палитру как CSS-переменные на `<html>`: компоненты берут цвета
 * через `var(--h-…)`, а не хардкодят их — смена темы не требует перерисовки
 * дерева. `terminal` (дизайн темы `2026-09-22-tui-theme-design.md`, раздел 6) —
 * не палитра, а отказ от темы в пользу цветов терминала; в окне взять их
 * неоткуда, поэтому `terminal` показывается как `mocha`.
 */

import { PALETTES, type Palette, type PaletteName } from './palettes.js';

/**
 * Шесть имён тем настроек: пять палитр плюс `terminal`. Значение то же, что
 * `THEME_NAMES` в `@harnas/core` (`config.ts`) — продублировано, а не
 * импортировано: рендерер в песочнице не тянет рантайм core (см. комментарий
 * в `lib/participant.ts`).
 */
export const THEME_NAMES = ['mocha', 'latte', 'gruvbox', 'nord', 'tokyo-night', 'terminal'] as const;

const isPaletteName = (name: string): name is PaletteName =>
  Object.prototype.hasOwnProperty.call(PALETTES, name);

export function resolvePalette(themeName: string): Palette {
  return isPaletteName(themeName) ? PALETTES[themeName] : PALETTES.mocha;
}

const VARS: ReadonlyArray<keyof Palette> = [
  'base',
  'mantle',
  'crust',
  'surface',
  'selection',
  'overlay',
  'text',
  'subtext',
  'muted',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
];

export function applyTheme(themeName: string, root: HTMLElement = document.documentElement): void {
  const palette = resolvePalette(themeName);
  for (const key of VARS) root.style.setProperty(`--h-${key}`, palette[key]);
  root.dataset.themeKind = palette.kind;
}
