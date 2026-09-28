/**
 * Разбор CSV и TSV для превью-таблицы (кусок 7.5, спека 10.6) — свой, по RFC 4180: поле в
 * кавычках может содержать разделитель, перевод строки и `""` (одна кавычка). Концы строк — LF и
 * CRLF. Нестрогий, как у редакторов: кавычка без пары тянет поле до конца текста, а не бросает.
 *
 * Разбор останавливается на `maxRows`: таблице больше не нужно, а файл до 20 МБ на миллион строк
 * иначе держал бы поток окна. Поля строки сверх `maxColumns` не копятся (fix-7.5): строка из сотен
 * тысяч полей от агента иначе дала бы такие же массивы и узлы DOM; её хвост дочитывается только
 * ради кавычек и конца строки.
 */

export function parseCsv(
  text: string,
  delimiter: ',' | '\t',
  maxRows: number,
  maxColumns = Number.POSITIVE_INFINITY,
): { rows: string[][]; truncated: boolean; columnsTruncated: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  // Начато ли поле: у отброшенного поля `field` пуст всегда, а кавычка открывает только начало поля.
  let started = false;
  let quoted = false;
  let columnsTruncated = false;
  let index = 0;
  const length = text.length;

  const endField = (): void => {
    if (row.length < maxColumns) row.push(field);
    else columnsTruncated = true;
    field = '';
    started = false;
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
  };
  const keep = (char: string): void => {
    started = true;
    if (row.length < maxColumns) field += char;
  };

  while (index < length) {
    const char = text[index] ?? '';
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          keep('"');
          index += 2;
          continue;
        }
        quoted = false;
      } else {
        keep(char);
      }
      index += 1;
      continue;
    }
    if (char === '"' && !started) {
      quoted = true;
      started = true;
    } else if (char === delimiter) {
      endField();
    } else if (char === '\n' || char === '\r') {
      if (rows.length === maxRows) return { rows, truncated: true, columnsTruncated };
      endRow();
      if (char === '\r' && text[index + 1] === '\n') index += 1;
    } else {
      keep(char);
    }
    index += 1;
  }
  // Последняя строка без перевода в конце; пустой хвост после последнего перевода — не строка.
  if (started || row.length > 0 || quoted) {
    if (rows.length === maxRows) return { rows, truncated: true, columnsTruncated };
    endRow();
  }
  return { rows, truncated: false, columnsTruncated };
}
