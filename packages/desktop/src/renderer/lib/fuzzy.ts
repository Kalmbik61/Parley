/**
 * Нечёткий поиск для палитры команд (кусок 2.3 плана окна, спека 5.2):
 * совпадение по подпоследовательности символов запроса в тексте. Полный
 * перебор без индекса — палитра ищет по паре десятков команд за раз, заводить
 * структуру данных под это дороже, чем она того стоит.
 *
 * Оценка выше у сплошного куска (`CONSECUTIVE_BONUS`) и у совпадения с начала
 * слова (`WORD_START_BONUS`) — так `s03` находит `S03 бэкенд` раньше строки,
 * где те же буквы подряд встретились случайно и вразнобой.
 */

const CHAR_SCORE = 1;
const CONSECUTIVE_BONUS = 5;
const WORD_START_BONUS = 3;

/** Начало слова: первый символ строки или символ сразу после не-буквы-не-цифры. */
function isWordStart(text: string, index: number): boolean {
  if (index === 0) return true;
  return !/[\p{L}\p{N}]/u.test(text.charAt(index - 1));
}

/**
 * Совпадение по подпоследовательности; выше — сплошной кусок и начало слова.
 * `null` — запрос не вкладывается в текст ни одной подпоследовательностью.
 */
export function fuzzyScore(query: string, text: string): number | null {
  if (query.length === 0) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t.length < q.length) return null;

  // `row[p]` — лучшая оценка совпадения первых `i + 1` символов запроса в
  // тексте при условии, что символ `q[i]` взят СТРОГО из позиции `p`. Без
  // этого условия нельзя было бы узнать при переходе к `q[i + 1]`, соседняя
  // ли это позиция (бонус за сплошной кусок) или нет.
  let row: Array<number | null> = new Array(t.length).fill(null);
  for (let p = 0; p < t.length; p++) {
    if (t.charAt(p) === q.charAt(0)) {
      row[p] = CHAR_SCORE + (isWordStart(t, p) ? WORD_START_BONUS : 0);
    }
  }

  for (let i = 1; i < q.length; i++) {
    const next: Array<number | null> = new Array(t.length).fill(null);
    // Максимум `row[0..p-1]`, накапливается по ходу прохода — так на каждую
    // позицию `p` не нужен отдельный проход назад по всему префиксу.
    let bestBefore: number | null = null;

    for (let p = 0; p < t.length; p++) {
      if (t.charAt(p) === q.charAt(i)) {
        const contiguous = p > 0 ? (row[p - 1] ?? null) : null;
        let best: number | null = contiguous === null ? null : contiguous + CONSECUTIVE_BONUS;
        if (bestBefore !== null) best = best === null ? bestBefore : Math.max(best, bestBefore);
        if (best !== null) {
          next[p] = CHAR_SCORE + (isWordStart(t, p) ? WORD_START_BONUS : 0) + best;
        }
      }

      const current = row[p] ?? null;
      if (current !== null) bestBefore = bestBefore === null ? current : Math.max(bestBefore, current);
    }

    row = next;
  }

  let result: number | null = null;
  for (const value of row) {
    if (value !== null) result = result === null ? value : Math.max(result, value);
  }
  return result;
}
