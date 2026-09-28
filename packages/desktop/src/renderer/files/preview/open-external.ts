/**
 * Одна точка, через которую превью (Markdown и аннотации PDF) открывают адрес наружу (кусок 7.5,
 * спека 10.6). Пока встроенного браузера в окне нет — системный браузер через `app.openExternal`;
 * с этапа 9 здесь же адрес уйдёт во вкладку браузера, и превью этого не заметят.
 *
 * Только `http(s)`: `file:`, `javascript:`, `data:` и прочее из файла агента — ничего. main
 * проверяет схему ещё раз (`app:open-external`).
 */

import type { HarnasBridge } from '../../../shared/bridge.js';

export function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export function openPreviewUrl(bridge: HarnasBridge, url: string): void {
  if (!isWebUrl(url)) return;
  bridge.app.openExternal(url).catch((error: unknown) => console.warn('[harnas] openExternal', error));
}
