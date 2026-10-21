// packages/desktop/src/main/browser/page-fns.ts
/**
 * Функции Parley, которые main исполняет в мире страницы через `Runtime.callFunctionOn` (этап D, задача 6). Закрытый
 * список CDP (`inspector.ts#cdpCallAllowed`) пускает этот метод только с функциями из `PAGE_FNS`; строк агента здесь нет.
 * Функции — ES5 без внешних глобалов, кроме встроенных страницы: они идут в чужой мир как есть.
 */
import { REACT_INFO_FN } from './react-info.js';

/**
 * `this` — `<select>`: выбирает `option` по `value`, затем по тексту; `input` и `change` всплывают.
 * Ответ: `{ ok: true, label }` или `{ ok: false, options }` (до 50 подписей; не `<select>` — пустой список).
 */
export const SELECT_OPTION_FN = `function (wanted) {
  var el = this;
  if (!el || el.tagName !== 'SELECT') return { ok: false, options: [] };
  var list = el.options;
  var found = -1;
  var i;
  for (i = 0; i < list.length; i++) {
    if (list[i].value === wanted) { found = i; break; }
  }
  if (found < 0) {
    for (i = 0; i < list.length; i++) {
      if ((list[i].textContent || '').trim() === wanted) { found = i; break; }
    }
  }
  if (found < 0) {
    var labels = [];
    for (i = 0; i < list.length && labels.length < 50; i++) labels[labels.length] = (list[i].textContent || '').trim();
    return { ok: false, options: labels };
  }
  el.selectedIndex = found;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, label: (list[found].textContent || '').trim() };
}`;

/** Функции, которые `cdpCallAllowed` пускает в `Runtime.callFunctionOn`. */
export const PAGE_FNS: ReadonlySet<string> = new Set([REACT_INFO_FN, SELECT_OPTION_FN]);
