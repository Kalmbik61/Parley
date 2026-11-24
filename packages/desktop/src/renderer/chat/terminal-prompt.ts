/**
 * Панель «вопрос терминала» в Chat (план 2026-11-18, задача 2): чистые части — какие строки экрана
 * показывать и какие байты уходят в терминал по нажатию. Вид и опрос — в `TerminalPromptPanel.tsx`.
 * Строки экрана — данные терминала: здесь они только режутся, никуда не пишутся.
 */

/** Сколько последних строк показывает панель: блок одобрения занимает 14–15 строк и растёт с длиной команды. */
export const PROMPT_ROWS_SHOWN = 20;
/** Как часто окно перечитывает экран, пока панель видна. */
export const PROMPT_POLL_MS = 400;
/** Пауза до внеочередного чтения после нажатия и до Enter после текста: Codex принимает быстрый текст с Enter за вставку. */
export const PROMPT_AFTER_KEY_MS = 80;

/** Последние непустые строки: пустое начало и хвост срезаны (вопрос на пустом экране стоит вверху), не больше `max`. */
export function promptLines(lines: readonly string[], max: number = PROMPT_ROWS_SHOWN): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === '') start += 1;
  while (end > start && lines[end - 1]!.trim() === '') end -= 1;
  return lines.slice(start, end).slice(-max);
}

const NAMED_KEYS: Readonly<Record<string, string>> = {
  ArrowUp: '\u001b[A',
  ArrowDown: '\u001b[B',
  ArrowRight: '\u001b[C',
  ArrowLeft: '\u001b[D',
  Enter: '\r',
  Escape: '\u001b',
  Tab: '\t',
  Backspace: '\u007f',
};

/** Байты для терминала по нажатию; `null` — клавиша не наша (сочетание с ⌘/Ctrl/Alt, одиночный модификатор, F-клавиши). */
export function keyData(event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }): string | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  const named = NAMED_KEYS[event.key];
  if (named !== undefined) return named;
  // Одиночный печатный знак (в том числе пробел и знак вне BMP); `Shift`, `F5`, `Dead` — длиннее.
  return [...event.key].length === 1 ? event.key : null;
}
