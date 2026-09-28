/**
 * Одна точка, через которую превью (Markdown и аннотации PDF) открывают адрес наружу (кусок 7.5,
 * спека 10.6). С этапа 9 — вкладка встроенного браузера в активной группе той же работы, тем же
 * путём, что ⌘-клик по адресу в терминале (9.2b, `openInBrowserTab`): предел вкладок браузера на
 * работу и его тост — оттуда же. Системный браузер превью не зовут.
 *
 * Только `http(s)`: `file:`, `javascript:`, `data:` и прочее из файла агента — ничего. Страница
 * вкладки — недоверенная и живёт в своём `webview` (спека 12), а не в окне.
 */

import { openInBrowserTab } from '../../browser/store.js';

export function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export function openPreviewUrl(url: string): void {
  if (!isWebUrl(url)) return;
  openInBrowserTab(url);
}
