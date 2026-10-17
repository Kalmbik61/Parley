// packages/desktop/src/renderer/browser/panel/agent-registry.ts
/**
 * Реестр страниц панелей для main (этап C, спека браузера 3.7, 3.10, 4.8). Агент работает со страницами панелей своего чата
 * и комнат; main о них не знает, пока окно не сообщит: страница, её гость и видимость, закрытие страницы, пауза панели.
 * Модуль помнит, что и кому уже отправлено, и повторов не шлёт. Вкладки человека не регистрируются никогда.
 *
 * Источники записей: подписка на раскладки (`startAgentRegistry` — гидрация, закрытие страниц, пауза) и поверхность страницы
 * (`reportAgentPage` — гость и видимость). Перезагрузка окна начинает с пустого состояния и нового поколения документа: первая
 * запись — `hello`, по ней main сбрасывает реестр. Кеш «что main уже знает» обновляется сразу, при отказе main откатывается, и
 * следующий `sync` шлёт запись снова.
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
/** Отчёты о страницах, которые main не принял: следующий `sync` пошлёт их заново с теми же гостем и видимостью. */
const failed = new Map<string, Sent>();

/** Поколение документа окна: случайный hex. Перезагрузка окна перезагружает и модуль — поколение новое. */
const newGeneration = (): string => Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => byte.toString(16).padStart(2, '0')).join('');
let generation = newGeneration();
let helloSent = false;

/** Отправка записи; `undo` вызывается при отказе main, чтобы кеш не считал недоставленное доставленным. */
function dispatch(bridge: ParleyBridge, e: AgentPageRegistration, undo: () => void): void {
  bridge.browser.registerTab(e).catch((error: unknown) => {
    console.warn('[parley] registerTab failed', error);
    undo();
  });
}

/** `hello` уходит раньше любой другой записи поколения; отказ на нём забывает кеш: main ещё не начал поколение. */
function ensureHello(bridge: ParleyBridge): void {
  if (helloSent) return;
  helloSent = true;
  const hello = generation;
  bridge.browser.registerTab({ kind: 'hello', generation: hello }).catch((error: unknown) => {
    console.warn('[parley] registerTab failed', error);
    if (generation !== hello) return;
    helloSent = false;
    pages.clear();
    pauses.clear();
    failed.clear();
  });
}

/** Страница панели: гость и видимость от её поверхности. Тот же отчёт повторно не шлётся. */
export function reportAgentPage(bridge: ParleyBridge, workKey: string, owner: BrowserOwner, pageId: string, webContentsId: number | null, visible: boolean): void {
  const key = `${workKey}\n${pageId}`;
  const known = pages.get(key);
  if (known?.webContentsId === webContentsId && known.visible === visible) return;
  ensureHello(bridge);
  const sent: Sent = { workKey, owner, webContentsId, visible };
  pages.set(key, sent);
  dispatch(bridge, { kind: 'page', generation, webContentsId, workKey, owner, pageId, visible }, () => {
    // Запись не дошла: забыть её, если за это время её не заменили, — следующий sync пошлёт снова.
    if (pages.get(key) !== sent) return;
    pages.delete(key);
    failed.set(key, sent);
  });
}

function sync(bridge: ParleyBridge, state: LayoutState): void {
  ensureHello(bridge);
  const seenPages = new Set<string>();
  const seenPanels = new Set<string>();
  for (const workKey of Object.keys(state.hydrated)) {
    for (const [key, panel] of Object.entries(state.layouts[workKey]?.panels ?? {})) {
      const owner = ownerOfKey(key);
      if (owner === null) continue;
      const panelKey = `${workKey}\n${ownerKey(owner)}`;
      seenPanels.add(panelKey);
      const paused = panel.paused === true;
      const before = pauses.get(panelKey);
      if ((before ?? false) !== paused) {
        pauses.set(panelKey, paused);
        dispatch(bridge, { kind: 'paused', generation, workKey, owner, paused }, () => {
          if (pauses.get(panelKey) !== paused) return;
          if (before === undefined) pauses.delete(panelKey);
          else pauses.set(panelKey, before);
        });
      }
      for (const page of panel.pages) {
        seenPages.add(`${workKey}\n${page.id}`);
        // Поверхность страницы уже отчиталась — не затираем её отчёт «без гостя».
        const pageKey = `${workKey}\n${page.id}`;
        if (pages.has(pageKey)) continue;
        const retry = failed.get(pageKey);
        failed.delete(pageKey);
        reportAgentPage(bridge, workKey, owner, page.id, retry?.webContentsId ?? null, retry?.visible ?? false);
      }
    }
  }
  for (const [key, sent] of [...pages]) {
    if (seenPages.has(key)) continue;
    pages.delete(key);
    dispatch(bridge, { kind: 'gone', generation, workKey: sent.workKey, pageId: key.slice(sent.workKey.length + 1) }, () => {
      // Закрытие не дошло: вернуть запись, и следующий sync увидит, что страницы в раскладке нет, и пошлёт `gone` снова.
      if (!pages.has(key)) pages.set(key, sent);
    });
  }
  for (const [key, paused] of [...pauses]) {
    if (seenPanels.has(key)) continue;
    pauses.delete(key);
    const [workKey, ownerId] = key.split('\n') as [string, string];
    const owner = ownerOfKey(ownerId);
    // Панель исчезла на паузе: пересозданная не должна унаследовать паузу main.
    if (paused && owner !== null) {
      dispatch(bridge, { kind: 'paused', generation, workKey, owner, paused: false }, () => {
        if (!pauses.has(key)) pauses.set(key, true);
      });
    }
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
  failed.clear();
  generation = newGeneration();
  helloSent = false;
}
