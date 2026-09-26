/**
 * Тема по системе (спека 4.7): выбор темы (`system`/`dark`/`light`) главный
 * процесс переносит в `nativeTheme.themeSource` (`app:set-appearance`), а
 * Electron сам держит `prefers-color-scheme` окна в синхроне с ним. Здесь —
 * только рендереровская половина: поставить `.dark` на `<html>` и подписаться
 * на смену медиа-запроса, чтобы её подхватить.
 */

/** Ставит или снимает `.dark` на `<html>` — единственное место, где рендерер трогает этот класс. */
export function applyDarkClass(dark: boolean, root: HTMLElement = document.documentElement): void {
  root.classList.toggle('dark', dark);
}

/**
 * Подписка на `prefers-color-scheme`. Свой выбор темы отсюда не идёт — окно
 * только читает результат, который уже отражает `nativeTheme.themeSource`,
 * выставленный главным процессом при старте и при `app:set-appearance`.
 */
export function watchSystemDark(onChange: (dark: boolean) => void): () => void {
  const media = matchMedia('(prefers-color-scheme: dark)');
  const listener = (event: MediaQueryListEvent): void => onChange(event.matches);
  media.addEventListener('change', listener);
  return () => media.removeEventListener('change', listener);
}
