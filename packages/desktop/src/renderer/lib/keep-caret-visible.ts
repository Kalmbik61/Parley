/**
 * Поле ввода (Chat и комната) растёт по тексту до `max-height`, дальше прокручивается. Родная прокрутка
 * за кареткой есть при наборе, но она оставляет последнюю строку вплотную к нижней рамке (нижний отступ поля
 * уходит за край), а после вставки, сделанной скриптом (`execCommand`, перенос, сброс текста, упоминание),
 * поле может вообще остаться на месте — каретка внизу за краем. Здесь поле докручивается само.
 *
 * Прокручивается только оно: `scrollIntoView` потянул бы за собой и страницу.
 */

/** Полоса каретки в координатах окна. */
interface CaretBand {
  top: number;
  bottom: number;
}

function visible(rect: DOMRect | undefined): rect is DOMRect {
  return rect !== undefined && rect.height > 0;
}

/**
 * Где каретка у `contentEditable`. Свёрнутый диапазон даёт прямоугольник, когда рядом есть текст; в пустой
 * строке (каретка сразу после `<br>` или перед ним) его нет, и тогда берётся прямоугольник самого `<br>`:
 * строка после него начинается под ним. Временный маркер в поле не вставляем: он трогает DOM и стек отмены.
 * Не нашлось ничего — `null`, поле остаётся как есть.
 */
function editableCaret(field: HTMLElement): CaretBand | null {
  const selection = field.ownerDocument.getSelection();
  if (selection === null || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0).cloneRange();
  if (!field.contains(range.startContainer)) return null;
  range.collapse(false);
  const own = Array.from(range.getClientRects()).reverse().find(visible) ?? [range.getBoundingClientRect()].find(visible);
  if (own !== undefined) return { top: own.top, bottom: own.bottom };
  const { endContainer, endOffset } = range;
  if (endContainer.nodeType !== Node.ELEMENT_NODE) return null;
  const before = endContainer.childNodes[endOffset - 1];
  if (before instanceof HTMLBRElement) {
    const rect = before.getBoundingClientRect();
    return visible(rect) ? { top: rect.bottom, bottom: rect.bottom + rect.height } : null;
  }
  const after = endContainer.childNodes[endOffset];
  if (after instanceof HTMLBRElement) {
    const rect = after.getBoundingClientRect();
    return visible(rect) ? { top: rect.top, bottom: rect.bottom } : null;
  }
  return null;
}

/**
 * Показать каретку вместе с нижним отступом поля. Не прокручивает, если поле не переполнено или каретка
 * уже видна целиком: человек, прокрутивший вверх и правящий середину, не должен «прыгать».
 * У `textarea` прямоугольника каретки нет — отрабатывается только конец текста (там отступ и пропадал);
 * правка в середине остаётся родной прокрутке.
 */
export function keepCaretVisible(field: HTMLElement): void {
  if (field.scrollHeight <= field.clientHeight) return;
  if (field instanceof HTMLTextAreaElement) {
    if (field.selectionEnd === field.value.length) field.scrollTop = field.scrollHeight - field.clientHeight;
    return;
  }
  const caret = editableCaret(field);
  if (caret === null) return;
  const viewTop = field.getBoundingClientRect().top + field.clientTop;
  const viewBottom = viewTop + field.clientHeight;
  const needBottom = caret.bottom + (Number.parseFloat(getComputedStyle(field).paddingBottom) || 0);
  if (needBottom > viewBottom) field.scrollTop += needBottom - viewBottom;
  else if (caret.top < viewTop) field.scrollTop -= viewTop - caret.top;
}
