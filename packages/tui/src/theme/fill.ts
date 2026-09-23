/**
 * Добивка строк зон до ширины блока (дизайн темы TUI, 5.1): `backgroundColor`
 * есть только у `<Text>`, значит каждая строка блока красится и добивается
 * отдельно. `pad` переехал из `sidebar.tsx` как есть; `fillLine` — общий
 * хелпер для сайдбара, панели, оверлеев и строки статуса (кусок 4).
 */

import stringWidth from 'string-width';
import type { Glyphs } from '../glyphs.js';
import { theme } from './index.js';
import type { RoleProps } from './roles.js';

/** Пробелы до `width` после `used` занятых колонок; `used > width` — пусто. */
export const pad = (used: number, width: number): string => ' '.repeat(Math.max(0, width - used));

/**
 * Строка ровно `width` колонок: короче — добивается пробелами, длиннее —
 * усекается. Ширина считается по колонкам (`string-width`), а не по
 * `String.length` — иначе широкий символ или многоточие сдвигали бы
 * добивку на знак и строка вылезала бы за пределы блока.
 */
export function fillLine(text: string, width: number): string {
  if (width <= 0) return '';
  const used = stringWidth(text);
  if (used <= width) return `${text}${pad(used, width)}`;
  let cut = text;
  while (cut.length > 0 && stringWidth(cut) > width) {
    cut = cut.slice(0, -1);
  }
  // Срез широкого символа на границе может снять сразу две колонки и отдать
  // width - 1: добиваем остаток пробелом, чтобы результат всегда был ровно
  // `width` колонок.
  return `${cut}${pad(stringWidth(cut), width)}`;
}

/**
 * Пропсы роли, только когда тема добивает фон (уровни 2 и 3, `theme().fills`);
 * иначе пусто — на уровнях ≤1 зоны не красятся вовсе (5.1), и кадр остаётся
 * знак в знак прежним. Общая точка ветвления для всех зон вместо повторения
 * `theme().fills ? role : {}` по каждому компоненту.
 */
export function zoneBg(role: RoleProps): RoleProps {
  return theme().fills ? role : {};
}

/**
 * Пробелы между левой и правой частью строки, чтобы вместе они заняли ровно
 * `width` колонок — замена `justifyContent: 'space-between'` там, где строка
 * зоны красится одним `<Text>` целиком (5.1), а не раскладкой `Box` из двух
 * текстов с терминальным фоном в зазоре между ними.
 */
export function gap(left: string, right: string, width: number): string {
  return pad(stringWidth(left) + stringWidth(right), width);
}

/**
 * Содержимое колонки-жёлоба слева у списков (дизайн темы TUI, 4.3, кусок 6):
 * пустая строка, когда жёлоб выключен (`theme().gutter === false`) — колонки
 * нет вовсе; знак `cursor` у выбранной строки и пробел у остальных, когда
 * включён. Одна функция на все списки (сайдбар и оверлей), а не по копии на
 * компонент; у двустрочного ряда вызывающий передаёт `selected: false` для
 * второй строки — маркер стоит только на первой (4.3).
 */
export function gutterMark(selected: boolean, g: Glyphs): string {
  if (!theme().gutter) return '';
  return selected ? g.cursor : ' ';
}

/**
 * Полезная ширина текста внутри списка с жёлобом: на одну колонку меньше при
 * включённом жёлобе, иначе не меняется. Общая точка расчёта для сайдбара и
 * оверлея (4.3) — жёлоб берёт колонку из ширины зоны, а не добавляет к ней,
 * и никто не считает `width - 1` у себя по месту.
 */
export function gutterWidth(width: number): number {
  return theme().gutter ? Math.max(0, width - 1) : width;
}
