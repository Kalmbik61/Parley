/**
 * Вложения поля ввода «Chat» (скриншот из буфера, брошенные на вид файлы, скрепка): над полем они живут
 * чипами, а в CLI уходят упоминаниями Claude Code `@"абсолютный путь"` в конце текста — при отправке CLI
 * сам прикладывает файл (картинку — картинкой), текст промпта в хуке и в журнале остаётся как набран.
 * Лента делает обратное: хвостовые упоминания промпта показывает чипами, а не текстом.
 */

import { shellQuote } from '../terminal/drop.js';

/**
 * Упоминание файла для CLI: `@"путь"`. Путь с `"`, `#` (у CLI это диапазон строк) или переводом строки
 * таким упоминанием не выразить — он идёт в shell-кавычках, как в терминале; CLI разберёт его сам, а лента
 * покажет текстом.
 */
export function attachmentMention(path: string): string {
  return /["#\r\n]/.test(path) ? shellQuote(path) : `@"${path}"`;
}

/**
 * Текст отправки: текст, затем упоминания через пробел и пробел в конце. Без пробела в конце у CLI на
 * `@токене` у каретки открылась бы своя подсказка файлов, и Enter хоста выбрал бы подсказку, а не
 * отправил сообщение. Без вложений — текст как есть.
 */
export function composePrompt(text: string, paths: readonly string[]): string {
  if (paths.length === 0) return text;
  const head = text.trimEnd();
  return `${head === '' ? '' : `${head} `}${paths.map(attachmentMention).join(' ')} `;
}

/** Хвостовое упоминание с абсолютным путём (`/…` или `C:\…`), за которым только пробелы. */
const TAIL_MENTION = /(?:^|\s)@"((?:\/|[A-Za-z]:\\)[^"\n]*)"\s*$/;

/**
 * Хвостовые упоминания `@"абсолютный путь"` промпта — вложения (порядок сохраняется), остальное — текст
 * без пробелов по краям. Упоминание посреди текста и относительные (`@src/a.ts`) остаются текстом: их
 * написал человек, а не окно.
 */
export function splitAttachments(text: string): { text: string; attachments: string[] } {
  const attachments: string[] = [];
  let rest = text;
  for (let match = TAIL_MENTION.exec(rest); match !== null; match = TAIL_MENTION.exec(rest)) {
    attachments.unshift(match[1] ?? '');
    rest = rest.slice(0, match.index);
  }
  return { text: rest.trim(), attachments };
}

/** Новые пути к уже стоящим вложениям: без повторов, в порядке добавления; ничего нового — тот же массив. */
export function addAttachments(current: readonly string[], paths: readonly string[]): readonly string[] {
  const fresh = [...new Set(paths)].filter((path) => !current.includes(path));
  return fresh.length === 0 ? current : [...current, ...fresh];
}
