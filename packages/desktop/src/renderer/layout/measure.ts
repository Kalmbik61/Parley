/**
 * Пиксельные размеры всех групп текущей раскладки — `GroupView.tsx` метит
 * каждую `data-group-id` (кусок 2.4). Нужны `splitGroup`/`moveTab` для отказа
 * «слишком мало места» (спека 5.2, «Числа»: минимум 240×160): в jsdom
 * (компонентные тесты) `getBoundingClientRect` без подмены дал бы одни нули.
 *
 * Отдельный модуль с куска 3.4: «Open to the side» меню строки сессии
 * (`sidebar/SessionRowMenu.tsx`) меряет группы так же, как меню раскладки `AppShell`.
 */

import type { GroupSizes } from './tree.js';

export function measureGroupSizes(): GroupSizes {
  const sizes: GroupSizes = {};
  for (const element of document.querySelectorAll<HTMLElement>('[data-group-id]')) {
    const id = element.dataset.groupId;
    if (id === undefined) continue;
    const rect = element.getBoundingClientRect();
    sizes[id] = { width: rect.width, height: rect.height };
  }
  return sizes;
}
