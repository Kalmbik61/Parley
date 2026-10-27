/**
 * Reply у ответа модели в «Chat» и у сообщения агента в комнате: что уходит цитатой. Выделен фрагмент внутри
 * сообщения — он целиком; иначе начало сообщения, не длиннее `REPLY_QUOTE_MAX` знаков с «…» (короткое — целиком):
 * весь ответ заново модели не нужен, он и так в её истории. Цитата уходит Markdown-блоком `> …` перед текстом
 * человека (`withQuote`), а пузырь промпта «Chat» показывает её свёрнутой (`splitQuote`).
 */

/** Предел цитаты всего сообщения, знаков. */
export const REPLY_QUOTE_MAX = 300;

/** Цитата: выделенный фрагмент, а нет его — начало текста до `REPLY_QUOTE_MAX` знаков. */
export function replyQuote(text: string, selected: string): string {
  const fragment = selected.trim();
  if (fragment !== '') return fragment;
  const chars = Array.from(text.trim());
  return chars.length <= REPLY_QUOTE_MAX ? chars.join('') : `${chars.slice(0, REPLY_QUOTE_MAX).join('').trimEnd()}…`;
}

/** Выделенный текст, если выделение целиком внутри `element`; иначе пусто. */
export function selectedTextIn(element: HTMLElement | null): string {
  const selection = window.getSelection();
  if (element === null || selection === null || selection.isCollapsed || selection.rangeCount === 0) return '';
  return element.contains(selection.getRangeAt(0).commonAncestorContainer) ? selection.toString() : '';
}

/** Текст отправки: цитата блоком `> …`, пустая строка, затем текст. */
export function withQuote(quote: string, text: string): string {
  const block = quote
    .split(/\r\n|\r|\n/)
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n');
  return text === '' ? block : `${block}\n\n${text}`;
}

/** Обратное `withQuote`: строки `>` в начале текста — цитата (без `> `), остальное — текст. */
export function splitQuote(text: string): { quote: string | null; text: string } {
  const lines = text.split('\n');
  let count = 0;
  while (count < lines.length && /^>(?: |$)/.test(lines[count] ?? '')) count += 1;
  if (count === 0) return { quote: null, text };
  return {
    quote: lines.slice(0, count).map((line) => line.replace(/^> ?/, '')).join('\n'),
    text: lines.slice(count).join('\n').trim(),
  };
}

/** Слэш-команда CLI (`/compact`, `/model opus`): цитата перед ней сломала бы её. Абсолютный путь (`/Users/…`) — не команда. */
export function isSlashCommand(text: string): boolean {
  return /^\/[A-Za-z][\w:-]*(?:\s|$)/.test(text.trimStart());
}
