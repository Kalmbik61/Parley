// packages/desktop/src/renderer/browser/panel/agent-registry.ts
/**
 * Реестр страниц панелей для main (этап C, спека браузера 3.7, 3.10, 4.8). Агент работает со страницами панелей своего чата
 * и комнат; main о них не знает, пока окно не сообщит: страница, её гость и видимость, закрытие страницы, пауза панели.
 * Модуль помнит, что и кому уже отправлено, и повторов не шлёт. Вкладки человека не регистрируются никогда.
 *
 * Источники записей: подписка на раскладки (`startAgentRegistry` — гидрация, закрытие страниц, пауза) и поверхность страницы
 * (`reportAgentPage` — гость и видимость). Перезагрузка окна начинает с пустого состояния: main сбрасывает реестр сам.
 */
import type { ParleyBridge } from '../../../shared/bridge.js';
import type { AgentPageRegistration } from '../../../shared/browser-types.js';
import type { BrowserOwner } from '../../../shared/layout-types.js';
import { ownerKey, ownerOfKey } from '../../layout/ids.js';
import { useLayoutStore, type LayoutState } from '../../layout/store.js';

interface Sent {
  workKey: string;
  owner: BrowserOwner;
  webContentsId: number | null;
  visible: boolean;
}
/** Что main уже знает: страницы по `workKey` и `pageId`, паузы по `workKey` и ключу хозяина. */
const pages = new Map<string, Sent>();
const pauses = new Map<string, boolean>();

const send = (bridge: ParleyBridge, e: AgentPageRegistration): void => {
  bridge.browser.registerTab(e).catch((error: unknown) => console.warn('[parley] registerTab failed', error));
};

/** Страница панели: гость и видимость от её поверхности. Тот же отчёт повторно не шлётся. */
export function reportAgentPage(bridge: ParleyBridge, workKey: string, owner: BrowserOwner, pageId: string, webContentsId: number | null, visible: boolean): void {
  const key = `${workKey}\n${pageId}`;
  const known = pages.get(key);
  if (known?.webContentsId === webContentsId && known.visible === visible) return;
  pages.set(key, { workKey, owner, webContentsId, visible });
  send(bridge, { webContentsId, workKey, owner, pageId, visible });
}

function sync(bridge: ParleyBridge, state: LayoutState): void {
  const seenPages = new Set<string>();
  const seenPanels = new Set<string>();
  for (const workKey of Object.keys(state.hydrated)) {
    for (const [key, panel] of Object.entries(state.layouts[workKey]?.panels ?? {})) {
      const owner = ownerOfKey(key);
      if (owner === null) continue;
      const panelKey = `${workKey}\n${ownerKey(owner)}`;
      seenPanels.add(panelKey);
      const paused = panel.paused === true;
      if ((pauses.get(panelKey) ?? false) !== paused) {
        pauses.set(panelKey, paused);
        send(bridge, { workKey, owner, paused });
      }
      for (const page of panel.pages) {
        seenPages.add(`${workKey}\n${page.id}`);
        // Поверхность страницы уже отчиталась — не затираем её отчёт «без гостя».
        if (!pages.has(`${workKey}\n${page.id}`)) reportAgentPage(bridge, workKey, owner, page.id, null, false);
      }
    }
  }
  for (const [key, sent] of [...pages]) {
    if (seenPages.has(key)) continue;
    pages.delete(key);
    send(bridge, { workKey: sent.workKey, pageId: key.slice(sent.workKey.length + 1), gone: true });
  }
  for (const [key, paused] of [...pauses]) {
    if (seenPanels.has(key)) continue;
    pauses.delete(key);
    const [workKey, ownerId] = key.split('\n') as [string, string];
    const owner = ownerOfKey(ownerId);
    // Панель исчезла на паузе: пересозданная не должна унаследовать паузу main.
    if (paused && owner !== null) send(bridge, { workKey, owner, paused: false });
  }
}

/** Подписка на раскладки (`AppShell`): гидрация, закрытие страниц, пауза. Возвращает отписку. */
export function startAgentRegistry(bridge: ParleyBridge): () => void {
  sync(bridge, useLayoutStore.getState());
  return useLayoutStore.subscribe((state) => sync(bridge, state));
}

/** Тесты: новое окно начинает с пустого состояния. */
export function resetAgentRegistry(): void {
  pages.clear();
  pauses.clear();
}
