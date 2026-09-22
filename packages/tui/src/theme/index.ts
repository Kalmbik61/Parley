/**
 * Реестр тем (дизайн темы TUI, 3.4): модульный синглтон рядом с глифами —
 * зеркало `applyGlyphsConfig`/`glyphs` в `glyphs.ts`. Настройки применяются
 * один раз при чтении конфига, компоненты зовут `theme()` в теле рендера,
 * перерисовку даёт смена состояния конфига.
 */

import chalk from 'chalk';
import { PALETTES, type Palette, type PaletteName } from './palettes.js';
import { roles, type Theme } from './roles.js';

const NAMES = Object.keys(PALETTES) as PaletteName[];

function isPaletteName(name: string): name is PaletteName {
  return (NAMES as string[]).includes(name);
}

/**
 * Имя `terminal` — явный отказ от палитры (3.4): роли отдают имена ANSI на
 * любом цветном уровне (3, 2, 1) — палитра значения не имеет. Уровень 0
 * (`NO_COLOR`, не TTY) через неё не переопределяется: там и так пусто.
 */
function resolve(name: string, level: number): { palette: Palette; level: number } {
  if (name === 'terminal') return { palette: PALETTES.mocha, level: level === 0 ? 0 : 1 };
  // Неизвестное имя — молча дефолт mocha: валидация имени живёт в core
  // (план, кусок 1), TUI от неё не падает.
  return { palette: isPaletteName(name) ? PALETTES[name] : PALETTES.mocha, level };
}

/**
 * Уровень цвета — свойство терминала, а не темы: он выясняется один раз и
 * живёт до конца работы. Поэтому он липкий — смена имени палитры его не
 * трогает. Иначе `useConfig`, применяя тему из файла, возвращал бы уровень к
 * `chalk.level` и сбрасывал бы `pinTheme` в тестах (дизайн 7.1).
 */
// Тип шире, чем `ColorSupportLevel` у chalk: уровень приходит и от `pinTheme`.
let level: number = chalk.level;
let current: Theme = roles(PALETTES.mocha, level);

/** Текущая тема: роли на уровне, применённом последним `applyThemeConfig`. */
export function theme(): Theme {
  return current;
}

/**
 * Применить тему по имени. `at` — уровень цвета (4.1); по умолчанию остаётся
 * прежний, а в начале работы это `chalk.level` — тем же уровнем красит и сам
 * Ink. Явный уровень нужен тестам и ничему больше.
 *
 * Уровень, с которым считаются роли, у `terminal` свой (ветка 1), но липким
 * становится именно `at`: иначе `terminal` навсегда опускал бы харнесс до
 * шестнадцати цветов и возврат к палитре ничего бы не дал.
 */
export function applyThemeConfig(name: string, at: number = level): void {
  level = at;
  const resolved = resolve(name, at);
  current = roles(resolved.palette, resolved.level);
}

export type { Palette, PaletteName, Theme };
export type { RoleProps } from './roles.js';
