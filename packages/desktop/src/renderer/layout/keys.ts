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
 */

export type LayoutKeyAction =
  | { kind: 'mru'; step: 1 | -1 }
  | { kind: 'tab-index'; index: number }
  | { kind: 'tab-step'; step: 1 | -1 };

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
  }
  return null;
}
