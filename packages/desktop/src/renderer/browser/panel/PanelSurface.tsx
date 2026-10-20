/**
 * Панель браузера хозяина в слое поверхностей работы (спека браузера 3.10, 4.11; этап B2, часть 1): полоска страниц и
 * `BrowserSurface` на каждую страницу панели — тот же браузер, что вкладка этапов A и B (строка, Console | Network, размеры,
 * Select, Annotate, доставка), но цель «To» закреплена за хозяином.
 *
 * Корень встаёт CSS-якорем на «участок панели» вида хозяина (`PanelHost`, `anchor.ts`), как поверхности вкладок встают на
 * тело группы: `<webview>` не пересоздаётся, пока жива панель, где бы ни стоял вид и показан ли он сейчас. Вид хозяина не на
 * экране (другая вкладка группы, закрытая панель, работа в фоне) — якоря нет, панель скрыта (`visibility: hidden`, `inert`)
 * и держит запасной размер: страницы скрытой панели остаются нормального размера, а не схлопываются до нуля.
 *
 * Страницы живы все, пока жива панель (предел живых панелей — `runtime.ts`, его применяет слой): переключение страниц в
 * полоске их не перезагружает. Видна только активная страница.
 */

import { useLayoutEffect, useRef } from 'react';
import type { WorkEntry } from '@parley/core';
import type { ParleyBridge } from '../../../shared/bridge.js';
import type { BrowserOwner, BrowserPanelSpec } from '../../../shared/layout-types.js';
import { ownerKey, ownerTabId } from '../../layout/ids.js';
import { useLayoutStore } from '../../layout/store.js';
import { focusTab } from '../../layout/tree.js';
import type { SendWithToastDeps } from '../../terminal/send.js';
import { isLendingFocus } from '../agent-activity.js';
import { BrowserSurface } from '../BrowserSurface.js';
import { useBrowserStore } from '../store.js';
import { panelAnchor } from './anchor.js';
import { PanelStrip } from './PanelStrip.js';
import { panelRuntimeKey, usePanelRuntime } from './runtime.js';

export interface PanelSurfaceProps {
  workKey: string;
  owner: BrowserOwner;
  panel: BrowserPanelSpec;
  /** Работа активна, панель открыта и вид хозяина на экране. */
  visible: boolean;
  bridge: ParleyBridge;
  entry: WorkEntry;
  sendDeps: SendWithToastDeps;
}

export function PanelSurface({ workKey, owner, panel, visible, bridge, entry, sendDeps }: PanelSurfaceProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const runtimeKey = panelRuntimeKey(workKey, owner);
  const narrow = usePanelRuntime((state) => state.hosts[runtimeKey]?.narrow === true);
  const area = panelAnchor(workKey, owner, 'area');

  // Якорные свойства — через `setProperty` (в `CSSProperties` @types/react 18 их нет). Запасные значения после запятой —
  // для панели без якоря: ширина панели и высота работы.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (el === null) return;
    el.style.setProperty('position-anchor', area);
    el.style.setProperty('top', 'anchor(top, 0px)');
    el.style.setProperty('left', 'anchor(left, 0px)');
    el.style.setProperty('width', `anchor-size(width, ${panel.width}px)`);
    el.style.setProperty('height', 'anchor-size(height, 100%)');
  }, [area, panel.width]);

  // `inert` в React 18 — не булев проп. Скрытая панель не получает ни фокуса, ни кликов.
  useLayoutEffect(() => {
    rootRef.current?.toggleAttribute('inert', !visible);
  }, [visible]);

  // Панель — сосед тела группы, а не потомок: клик в неё делает группу и вкладку хозяина активными и ставит панель в конец
  // очереди на выгрузку. Фокус вкладки — и по клавиатуре; свежесть — только по клику.
  const focusOwner = (): void => {
    useLayoutStore.getState().apply(workKey, (layout) => focusTab(layout, ownerTabId(owner)));
  };

  // Фокус, который окно одолжило гостю по просьбе агента, вид хозяина активным не делает (рецензия M1); клик человека — делает.
  const focusOwnerUnlessLending = (): void => {
    const tabs = useBrowserStore.getState().tabs;
    // Агент вводит и в скрытые страницы панели (решение владельца 8): смотрим гостей всех её страниц.
    if (!panel.pages.some((page) => isLendingFocus(tabs[page.id]?.webContentsId ?? null))) focusOwner();
  };

  return (
    <div
      ref={rootRef}
      data-testid="browser-panel"
      data-panel-owner={ownerKey(owner)}
      data-agents-paused={panel.paused === true ? 'true' : undefined}
      className="absolute flex flex-col overflow-hidden border-l border-border bg-background"
      style={{ visibility: visible ? 'visible' : 'hidden' }}
      onPointerDownCapture={() => {
        usePanelRuntime.getState().touch(runtimeKey);
        focusOwner();
      }}
      onFocusCapture={focusOwnerUnlessLending}
    >
      <PanelStrip workKey={workKey} owner={owner} panel={panel} entry={entry} narrow={narrow} />
      <div className="relative min-h-0 flex-1">
        {panel.pages.map((page) => (
          <BrowserSurface
            key={page.id}
            workKey={workKey}
            place={{ kind: 'panel', owner, pageId: page.id }}
            url={page.url}
            viewport={page.viewport ?? null}
            visible={visible && page.id === panel.active}
            bridge={bridge}
            entry={entry}
            sendDeps={sendDeps}
          />
        ))}
      </div>
    </div>
  );
}
