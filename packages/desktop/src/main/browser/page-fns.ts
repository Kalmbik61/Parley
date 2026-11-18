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

/**
 * `this` — цель клика; `recenter` — сначала прокрутить цель в середину вьюпорта. Спрашивает у своего документа (сквозь
 * открытые теневые корни), какой элемент лежит в центре рамки цели. Не перекрыта: сама цель, её потомок или предок,
 * `<label>` её поля, рамка нулевого размера, точка вне страницы. Ответ: `{ covered: false }` или
 * `{ covered: true, by }` — тег, роль и первые 60 знаков текста верхнего элемента (данные страницы).
 */
export const HIT_TEST_FN = `function (recenter) {
  var el = this;
  if (!el || el.nodeType !== 1) return { covered: false };
  if (recenter) el.scrollIntoView({ block: 'center', inline: 'center' });
  var rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return { covered: false };
  var x = rect.left + rect.width / 2;
  var y = rect.top + rect.height / 2;
  var root = el.getRootNode ? el.getRootNode() : el.ownerDocument;
  var top = root && root.elementFromPoint ? root.elementFromPoint(x, y) : el.ownerDocument.elementFromPoint(x, y);
  if (!top) return { covered: false };
  var node = top;
  while (node) {
    if (node === el) return { covered: false };
    node = node.parentNode || node.host;
  }
  if (top.contains && top.contains(el)) return { covered: false };
  var label = top.closest ? top.closest('label') : null;
  if (label && label.control === el) return { covered: false };
  var text = (top.getAttribute('aria-label') || top.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
  var role = top.getAttribute('role');
  return { covered: true, by: top.tagName.toLowerCase() + (role ? '[role=' + role + ']' : '') + (text ? ' "' + text + '"' : '') };
}`;

/** Функции, которые `cdpCallAllowed` пускает в `Runtime.callFunctionOn`. */
export const PAGE_FNS: ReadonlySet<string> = new Set([REACT_INFO_FN, SELECT_OPTION_FN, HIT_TEST_FN]);
