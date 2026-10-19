/** Форматирование текста для Telegram (parse_mode HTML): экранирование, обрезка, разбиение на сообщения. */

export const TRUNCATED_TAIL = '… (truncated, open in Parley)';

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Обрезает до `max` знаков вместе с хвостом. */
export function clipText(text: string, max = 1500): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - TRUNCATED_TAIL.length))}${TRUNCATED_TAIL}`;
}

/** Режет по `\n\n`, затем по `\n`, затем жёстко; каждый кусок не длиннее `max`. */
export function splitText(text: string, max = 4096): string[] {
  if (text.length === 0) return [];
  if (text.length <= max) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max + 1);
    let cut = window.lastIndexOf('\n\n');
    let skip = 2;
    if (cut <= 0) {
      cut = window.lastIndexOf('\n');
      skip = 1;
    }
    if (cut <= 0) {
      cut = max;
      skip = 0;
    }
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut + skip);
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

/** Последние `n` непустых строк. */
export function lastLines(text: string, n = 2): string {
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-n)
    .join('\n');
}
