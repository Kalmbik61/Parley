/**
 * Подсказки поля ввода «Chat» — чистая логика без React (живая проверка 2026-10-02): по тексту и
 * каретке понять, что человек сейчас набирает (слеш-команду, `/model <id>`, `@`-упоминание), и вставить
 * выбранное. Окно только подставляет текст в поле — разбирает его сам CLI, автоответов нет.
 */

export type SuggestionContext =
  | { kind: 'command'; query: string; start: number }
  | { kind: 'model'; query: string; start: number }
  | { kind: 'mention'; query: string; start: number };

/**
 * Что набирает человек перед кареткой: `null` — подсказок нет. Слеш-команда — только когда весь текст
 * до каретки это `/слово`; `/model <часть id>` — выбор модели; `@` в начале слова — субагент или файл.
 */
export function suggestionContext(text: string, caret: number): SuggestionContext | null {
  const before = text.slice(0, caret);
  const command = /^\/([\w:.-]*)$/.exec(before);
  if (command !== null) return { kind: 'command', query: command[1] ?? '', start: 0 };
  const model = /^\/model\s+(\S*)$/.exec(before);
  if (model !== null) return { kind: 'model', query: model[1] ?? '', start: 0 };
  const mention = /(^|\s)@(\S*)$/.exec(before);
  if (mention !== null) {
    const query = mention[2] ?? '';
    return { kind: 'mention', query, start: caret - query.length - 1 };
  }
  return null;
}

/**
 * Заменяет набранный токен (от `context.start` до каретки) готовой вставкой — вместе с `/` или `@` и
 * хвостовым пробелом, если он нужен. Каретка встаёт сразу после вставки. Пробел вставки не удваивается,
 * если текст после каретки уже начинается с пробела.
 */
export function applySuggestion(
  text: string,
  caret: number,
  context: SuggestionContext,
  insert: string,
): { text: string; caret: number } {
  const rest = text.slice(caret);
  const tail = insert.endsWith(' ') && rest.startsWith(' ') ? rest.slice(1) : rest;
  return { text: `${text.slice(0, context.start)}${insert}${tail}`, caret: context.start + insert.length };
}
