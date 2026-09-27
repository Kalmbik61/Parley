/**
 * Клавиши раскладки, которые ловит сам рендерер, а не системное меню (спека
 * 5.3, кусок 2.4) — временно, до реестра клавиш куска 6.1: ⌃Tab/⌃⇧Tab (MRU
 * вкладок работы), ⌃1–9 (вкладка по номеру в активной группе), ⌘⇧[/⌘⇧]
 * (предыдущая/следующая вкладка активной группы). ⌘[/⌘] (соседняя ГРУППА) и
 * ⌘⇧T (вернуть закрытую) остаются пунктами меню (`main/menu.ts`) — тут не
 * распознаются.
 *
 * Чистая функция от `KeyboardEvent` к действию — сам обработчик (какую
 * вкладку выбрать, как крутить MRU) держит `LayoutView.tsx`, у которого есть
 * стор и раскладка активной работы.
 *
 * Кусок 3.4 (спека 6.5): ⌘⇧↑/⌘⇧↓ — соседняя работа видимого порядка сайдбара,
 * исход `work-step`. Его разбирает только `AppShell`: `LayoutView` смонтирован у трёх
 * работ LRU, и работа не должна переключаться трижды. До реестра клавиш 6.1 это
 * `keydown` в рендерере, а не акселератор меню: пункт меню отнимал бы у полей ввода
 * выделение до начала и конца.
 */

export type LayoutKeyAction =
  | { kind: 'mru'; step: 1 | -1 }
  | { kind: 'tab-index'; index: number }
  | { kind: 'tab-step'; step: 1 | -1 }
  /** ⌘⇧↓ — 1, ⌘⇧↑ — −1; разбирает только `AppShell`. */
  | { kind: 'work-step'; step: 1 | -1 };

export function layoutKeyAction(event: KeyboardEvent): LayoutKeyAction | null {
  if (event.ctrlKey && !event.metaKey) {
    if (event.key === 'Tab') return { kind: 'mru', step: event.shiftKey ? -1 : 1 };
    if (!event.shiftKey && event.key >= '1' && event.key <= '9') {
      return { kind: 'tab-index', index: Number(event.key) - 1 };
    }
    return null;
  }
  if (event.metaKey && event.shiftKey && !event.ctrlKey) {
    if (event.key === '[') return { kind: 'tab-step', step: -1 };
    if (event.key === ']') return { kind: 'tab-step', step: 1 };
    if (event.key === 'ArrowUp') return { kind: 'work-step', step: -1 };
    if (event.key === 'ArrowDown') return { kind: 'work-step', step: 1 };
  }
  return null;
}

/**
 * Фокус в поле ввода (спека 9.6): ⌘⇧↑↓ там — выделение до края, окну не достаётся.
 * Терминал — не поле: его фокус — `textarea.xterm-helper-textarea`, а ⌘-сочетания
 * терминала идут окну, поэтому `.xterm` проверяется раньше `textarea`.
 */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('.xterm') !== null) return false;
  if (target.closest('input, textarea') !== null) return true;
  return target.closest('[contenteditable]:not([contenteditable="false"])') !== null;
}

/**
 * Соседняя работа в порядке по кругу. Активной в порядке нет (её проект свёрнут, `done`
 * скрыта) — вперёд первая, назад последняя; порядок пуст — `null`.
 */
export function neighborInOrder(order: readonly string[], current: string | null, step: 1 | -1): string | null {
  if (order.length === 0) return null;
  const index = current === null ? -1 : order.indexOf(current);
  if (index === -1) return (step === 1 ? order[0] : order[order.length - 1]) ?? null;
  return order[(((index + step) % order.length) + order.length) % order.length] ?? null;
}
