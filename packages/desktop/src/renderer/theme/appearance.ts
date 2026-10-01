/**
 * Тема окна (спека 4.7): выбор темы (`system`/`dark`/`light`) главный процесс
 * переносит в `nativeTheme.themeSource` (`app:set-appearance`). Источник истины
 * тёмности — `nativeTheme.shouldUseDarkColors` main (раунд main-r2, п. 1): начальное
 * значение — `app.isDark()`, дальше — `app:appearance` на каждое `nativeTheme.on('updated')`
 * (и смену системной темы при `system`, и выбор в палитре или Settings). Рендерер сам
 * `prefers-color-scheme` не читает: в E2E Playwright подменяет его эмуляцией, и окно
 * расходилось бы с выбором человека.
 */

import type { ParleyBridge } from '../../shared/bridge.js';

/** Ставит или снимает `.dark` на `<html>` — единственное место, где рендерер трогает этот класс. */
export function applyDarkClass(dark: boolean, root: HTMLElement = document.documentElement): void {
  root.classList.toggle('dark', dark);
}

/** Тёмность main: сразу текущая, затем каждая смена. Возвращает отписку. */
export function followAppearance(bridge: ParleyBridge, onChange: (dark: boolean) => void): () => void {
  onChange(bridge.app.isDark());
  return bridge.app.onAppearance(onChange);
}
