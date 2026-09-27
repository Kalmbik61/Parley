/**
 * Вспышка вкладки после перехода по уведомлению (кусок 4.3, спека 7.4): `data-flash` на
 * время анимации, кольцо 2px `--ring` рисует CSS (`styles/attention-flash.css`).
 */

/** Длительность вспышки (спека 7.4). */
const FLASH_MS = 600;

const timers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

/** data-flash на [role="tab"][data-work-key][data-tab-id] на durationMs; кольцо 2px --ring рисует CSS. */
export function flashTab(workKey: string, tabId: string, durationMs: number = FLASH_MS): void {
  // Пара работа + вкладка: id `mail` и `terminal:s-01` одинаковы во всех работах LRU, а
  // `data-tab-id` носит и поверхность терминала. Сравнение через dataset — без экранирования
  // пути проекта в селекторе.
  const tab = [...document.querySelectorAll<HTMLElement>('[role="tab"][data-work-key][data-tab-id]')].find(
    (element) => element.dataset.workKey === workKey && element.dataset.tabId === tabId,
  );
  if (tab === undefined) return;
  const previous = timers.get(tab);
  if (previous !== undefined) clearTimeout(previous);
  // Снять и поставить заново — повторная вспышка перезапускает анимацию CSS.
  tab.removeAttribute('data-flash');
  void tab.offsetWidth;
  tab.setAttribute('data-flash', '');
  timers.set(
    tab,
    setTimeout(() => {
      timers.delete(tab);
      tab.removeAttribute('data-flash');
    }, durationMs),
  );
}
