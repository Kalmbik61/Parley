// packages/desktop/src/renderer/browser/annotate/use-annotate-mode.ts
/**
 * Режим Annotate вкладки (спека браузера 4.7): цикл «метка — редактор — снова метка», пока режим включён; метки
 * страницы — по лотку; «Add to chat» — один файл `annotations` и один снимок страницы с номерами. Данные меток сняты в
 * момент их создания, поэтому лоток переживает смену документа. Меток на странице уже нет — файл уходит без снимка.
 *
 * Страница и окно знают о метках по-разному: временный номер метки до её сохранения рисует сам скрипт страницы, а
 * убирает его только следующая перерисовка (`annotateSync`). Поэтому перерисовка идёт не только по смене состава лотка:
 * её просят явно там, где состав мог не измениться (`cancelMark`, метка, не принятая лотком).
 */

import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import type { ParleyBridge } from '../../../shared/bridge.js';
import type { AnnotationPick } from '../../../shared/browser-types.js';
import { annotationsContext, CONTEXT_LIMITS } from '../../../shared/context-markdown.js';
import { decodeIpcError } from '../../../shared/ipc-error.js';
import { errorText, S } from '../../../shared/strings.js';
import type { ContextDraft, Delivered } from '../context/deliver.js';
import { useBrowserStore } from '../store.js';
import { EMPTY_ANNOTATE, pinsOf, useAnnotateStore, type AnnotationItem } from './store.js';

/**
 * Перерисовать метки страницы по лотку (только пункты её документа) и пометить пропавшие элементы. Ответ мог опоздать:
 * пока он был в пути, начался новый документ (`generation` вырос) или вкладку закрыли — положения прежнего документа
 * ничему из нынешнего не принадлежат. Особенно номерам: человек убрал прежнюю строку, и её номер достался новой метке —
 * ответ прежнего документа попал бы в неё по номеру. Перенумерация в пределах одного документа (убрали строку, пока ответ
 * в пути) допускается: следующая перерисовка, её запускает смена состава лотка, исправит один кадр.
 */
export async function syncPins(bridge: ParleyBridge, tabId: string, webContentsId: number): Promise<void> {
  const sent = useAnnotateStore.getState().tabs[tabId] ?? EMPTY_ANNOTATE;
  try {
    const positions = await bridge.browser.annotateSync(webContentsId, pinsOf(sent));
    const now = useAnnotateStore.getState().tabs[tabId];
    if (now === undefined || now.generation !== sent.generation) return;
    useAnnotateStore.getState().markPositions(tabId, positions);
  } catch (error) {
    console.warn('[parley] annotateSync failed', error);
  }
}

/**
 * Набранное в открытом редакторе — в комментарий его пункта (Save без нажатия); редактор закрыт. Редактора нет — ничего
 * не меняется, и записи лотка у вкладки не появляется.
 */
export function saveDraft(tabId: string): void {
  const store = useAnnotateStore.getState();
  if (store.tabs[tabId]?.editing != null) store.save(tabId);
}

/**
 * Отмена новой метки (Esc или Delete в её редакторе): пункт уходит из лотка, а страница уже нарисовала временный номер и
 * убирает его только перерисовкой. Обычно её запускает смена меток лотка (эффект `useAnnotateMode`), но на смену состава
 * между двумя рендерами она не полагается: перерисовать — здесь. Готовая метка (Esc при правке) не меняется.
 */
export async function cancelMark(bridge: ParleyBridge, tabId: string, webContentsId: number | null): Promise<void> {
  const store = useAnnotateStore.getState();
  const wasNew = store.tabs[tabId]?.editing?.isNew === true;
  store.cancelEdit(tabId);
  if (wasNew && webContentsId !== null) await syncPins(bridge, tabId, webContentsId);
}

/** Редактор закрыт (Save, Delete, Esc): следующая метка — только после этого. */
function editorClosed(tabId: string): Promise<void> {
  return new Promise((resolve) => {
    const closed = (): boolean => (useAnnotateStore.getState().tabs[tabId]?.editing ?? null) === null;
    if (closed()) {
      resolve();
      return;
    }
    const unsubscribe = useAnnotateStore.subscribe(() => {
      if (!closed()) return;
      unsubscribe();
      resolve();
    });
  });
}

export function useAnnotateMode({
  bridge,
  tabId,
  webContentsId,
  active,
  urlRef,
}: {
  bridge: ParleyBridge;
  tabId: string;
  webContentsId: number | null;
  active: boolean;
  /** Живой адрес страницы вкладки (его ведёт поверхность): метка запоминает его на момент ответа скрипта. */
  urlRef: { readonly current: string };
}): void {
  useEffect(() => {
    if (!active || webContentsId === null) return undefined;
    let alive = true;
    const off = (): void => useBrowserStore.getState().update(tabId, { mode: 'off' });
    void (async () => {
      while (alive) {
        // Редактор открыт — страница не взводится, пока он не закрыт. Ждать надо в начале витка, а не в конце: ✎ «выкл — вкл»
        // оставляет редактор открытым, и новый цикл взвёл бы страницу сразу — следующая метка легла бы поверх него.
        await editorClosed(tabId);
        if (!alive) return;
        if ((useAnnotateStore.getState().tabs[tabId]?.items.length ?? 0) >= CONTEXT_LIMITS.annotations) {
          toast(S.browser.annotate.limit);
          off();
          return;
        }
        let pick: AnnotationPick | null;
        try {
          pick = await bridge.browser.annotateStart(webContentsId);
        } catch (error) {
          if (!alive) return;
          console.error('[parley] annotateStart failed', error);
          toast(errorText(decodeIpcError(error).code, S.errors.actions.annotate));
          off();
          return;
        }
        // Режим сняли (✎, Esc в окне, навигация, скрытая вкладка) — поздний ответ ничего не ставит.
        if (!alive) return;
        if (pick === null) {
          off();
          return;
        }
        // Клик по номеру готовой метки: её положение в `rect` пункта — с прошлой перерисовки, а страницу могли прокрутить.
        // Редактор откроется у свежего места.
        if (pick.kind === 'edit') {
          await syncPins(bridge, tabId, webContentsId);
          if (!alive) return;
        }
        // Редактор могли открыть из лотка, пока страница ждала клика: набранное в нём — в комментарий, а не под новый редактор.
        saveDraft(tabId);
        const store = useAnnotateStore.getState();
        const count = store.tabs[tabId]?.items.length ?? 0;
        store.receive(tabId, pick, urlRef.current);
        // Лоток новую метку не принял (предел 20: пока страница ждала клика, «Undo» вернул пачку), а скрипт уже нарисовал
        // для неё временный номер — убирает его только перерисовка, и состав лотка не менялся.
        if (pick.kind !== 'edit' && (useAnnotateStore.getState().tabs[tabId]?.items.length ?? 0) === count) {
          void syncPins(bridge, tabId, webContentsId);
        }
      }
    })();
    return () => {
      alive = false;
      bridge.browser.annotateCancel(webContentsId).catch((error: unknown) => console.warn('[parley] annotateCancel failed', error));
    };
  }, [active, bridge, tabId, webContentsId, urlRef]);

  // Метки страницы — по лотку: новая, отменённая, удалённая, очищенная, возвращённая по Undo; пункты прошлых документов в страницу не уходят.
  const pins = useAnnotateStore((state) => pinsOf(state.tabs[tabId] ?? EMPTY_ANNOTATE).map(({ n, key }) => `${n}:${key}`).join(','));
  const hadPins = useRef(false);
  useEffect(() => {
    if (webContentsId === null || (pins === '' && !hadPins.current)) return;
    hadPins.current = pins !== '';
    void syncPins(bridge, tabId, webContentsId);
  }, [pins, bridge, tabId, webContentsId]);
}

export interface AnnotationsToChat {
  bridge: ParleyBridge;
  tabId: string;
  webContentsId: number | null;
  pageUrl: string;
  viewportNote: string | null;
  add(draft: ContextDraft): Promise<Delivered>;
}

/** Опознавательный знак пункта: ключ метки уникален лишь в пределах поколения документа. */
const identity = (item: AnnotationItem): string => `${item.generation}:${item.key}`;

/** «Add to chat» лотка: метки на месте — снимок с номерами, файл, пачка — из лотка; не вышло — пачка возвращается. */
export async function addAnnotationsToChat(deps: AnnotationsToChat): Promise<void> {
  // Набранный, но не сохранённый комментарий — часть пачки: файл строится из `items`, а черновика в них ещё нет.
  saveDraft(deps.tabId);
  const before = useAnnotateStore.getState().tabs[deps.tabId]?.items ?? [];
  if (before.length === 0) return;
  const id = deps.webContentsId;
  if (id !== null) await syncPins(deps.bridge, deps.tabId, id);
  const items = useAnnotateStore.getState().tabs[deps.tabId]?.items ?? before;
  const path =
    id === null
      ? null
      : await deps.bridge.browser.annotateCapture(id).then(
          (shot) => shot.path,
          (error: unknown) => {
            console.warn('[parley] annotateCapture failed', error);
            return null;
          },
        );
  const built = annotationsContext({
    pageUrl: deps.pageUrl,
    viewport: items[0]?.target.viewport ?? null,
    viewportNote: deps.viewportNote,
    screenshot: path !== null,
    items: items.map(({ n, comment, gone, url, target }) => ({ n, comment, gone, url, target })),
  });
  const filed = new Set(items.map(identity));
  const removed = useAnnotateStore.getState().clear(deps.tabId);
  // Метка, поставленная, пока шли перерисовка и снимок, в файл не вошла (и на снимке её нет): она остаётся в лотке, а не
  // уходит в пачку «Undo» и не попадает в число тоста.
  const pack = removed.filter((item) => filed.has(identity(item)));
  const later = removed.filter((item) => !filed.has(identity(item)));
  if (later.length > 0) useAnnotateStore.getState().restore(deps.tabId, later);
  const restore = (): void => useAnnotateStore.getState().restore(deps.tabId, pack);
  const delivered = await deps.add({ ...built, imagePath: path, count: pack.length, onUndo: restore });
  if (delivered === 'failed') restore();
}
