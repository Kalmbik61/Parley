/**
 * Добивка строк зон до ширины блока (дизайн темы TUI, 5.1): `backgroundColor`
 * есть только у `<Text>`, значит каждая строка блока красится и добивается
 * отдельно. `pad` переехал из `sidebar.tsx` как есть; `fillLine` — общий
 * хелпер для сайдбара, панели, оверлеев и строки статуса (кусок 4).
 */

import stringWidth from 'string-width';

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
