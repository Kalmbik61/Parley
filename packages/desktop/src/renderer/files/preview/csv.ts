/**
 * Разбор CSV и TSV для превью-таблицы (кусок 7.5, спека 10.6) — свой, по RFC 4180: поле в
 * кавычках может содержать разделитель, перевод строки и `""` (одна кавычка). Концы строк — LF и
 * CRLF. Нестрогий, как у редакторов: кавычка без пары тянет поле до конца текста, а не бросает.
 *
 * Разбор останавливается на `maxRows`: таблице больше не нужно, а файл до 20 МБ на миллион строк
 * иначе держал бы поток окна.
 */

export function parseCsv(text: string, delimiter: ',' | '\t', maxRows: number): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let index = 0;
  const length = text.length;

  const endRow = (): void => {
    row.push(field);
    rows.push(row);
    row = [];
    field = '';
  };

  while (index < length) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
      } else {
        field += char;
      }
      index += 1;
      continue;
    }
    if (char === '"' && field === '') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (rows.length === maxRows) return { rows, truncated: true };
      endRow();
      if (char === '\r' && text[index + 1] === '\n') index += 1;
    } else {
      field += char;
    }
    index += 1;
  }
  // Последняя строка без перевода в конце; пустой хвост после последнего перевода — не строка.
  if (field !== '' || row.length > 0 || quoted) {
    if (rows.length === maxRows) return { rows, truncated: true };
    endRow();
  }
  return { rows, truncated: false };
}
