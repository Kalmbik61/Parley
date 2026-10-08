// packages/desktop/src/renderer/browser/devtools/use-devtools-feed.ts
/**
 * Журнал гостя в окне (спека 2026-10-07-browser-devtools-agent-design.md, 3.5, раздел 9).
 * - Как только известен гость (`dom-ready`), — снимок `devtoolsSnapshot`, дальше — пачки `browser:devtools` своего гостя.
 * - Пачки до `dom-ready` фильтр по id отбрасывает: их возвращает снимок (Фокус ревью 4). Подписка — раньше снимка: пачка
 *   между ними уже в снимке, а повтор записи по id безвреден.
 * - Новый гость той же вкладки (падение, повторное подключение) нумерует записи с 1 без `reset`: ранняя пачка может
 *   смешаться со старым журналом, но снимок заменяет оба списка целиком — буфера не нужно.
 * - Открытие панели снимает журнал заново: в болтливой консоли пачки несут только свежее (Фокус ревью 1).
 * - Вкладка ушла — её журнал из окна убран.
 */
import { useEffect } from 'react';
import type { ParleyBridge } from '../../../shared/bridge.js';
import { useDevtoolsStore } from './store.js';

export function useDevtoolsFeed(bridge: ParleyBridge, tabId: string, webContentsId: number | null, open: boolean): void {
  useEffect(() => {
    if (webContentsId === null) return undefined;
    return bridge.browser.onDevtools((batch) => {
      if (batch.webContentsId === webContentsId) useDevtoolsStore.getState().batch(tabId, batch);
    });
  }, [bridge, tabId, webContentsId]);

  useEffect(() => {
    if (webContentsId === null) return undefined;
    let current = true;
    bridge.browser.devtoolsSnapshot(webContentsId).then(
      (snapshot) => {
        if (current) useDevtoolsStore.getState().snapshot(tabId, snapshot);
      },
      (error: unknown) => console.warn('[parley] devtools snapshot failed', error),
    );
    return () => {
      current = false;
    };
  }, [bridge, tabId, webContentsId, open]);

  useEffect(() => () => useDevtoolsStore.getState().remove(tabId), [tabId]);
}
