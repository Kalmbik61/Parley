/**
 * Вид хозяина с местом под панель браузера (спека браузера 3.10, 4.11; этап B2, часть 1). Оборачивает вид сессии (Chat и
 * терминал) или комнаты: рядом с видом стоит «участок панели» — пустой блок с именем CSS-якоря, на который встаёт сама
 * панель из слоя поверхностей работы (`PanelSurface`): `<webview>` страниц не должен пересоздаваться, когда человек уходит
 * на другую вкладку группы и возвращается.
 * - Широкий вид: участок рядом с видом, шириной панели от 320 px до 70 % вида (виду остаётся не меньше 240 px); ширину тянет ручка между ними
 *   (`shell/Resizer.tsx`, в раскладку — на `pointerup`). Терминал сессии уступает ему место по якорю `reserve`.
 * - Вид уже 560 px (в том числе окно 800×500): участок поверх вида целиком, ручки нет; вид под ним недоступен (`inert`) —
 *   чат до нечитаемого не сжимается, вернуться к нему можно кнопкой «Back to chat» полоски панели.
 * Вид сообщает о себе стору окна (`runtime.ts`): панель видна, только пока вид хозяина на экране, а узкий он или нет —
 * нужно полоске панели.
 */

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { BrowserOwner } from '../../../shared/layout-types.js';
import { ownerKey } from '../../layout/ids.js';
import { useLayoutStore } from '../../layout/store.js';
import { PANEL_LIMITS } from '../../layout/tree.js';
import { Resizer } from '../../shell/Resizer.js';
import { resizePanel } from './actions.js';
import { panelAnchor } from './anchor.js';
import { panelRuntimeKey, usePanelRuntime } from './runtime.js';

export interface PanelHostProps {
  workKey: string;
  owner: BrowserOwner;
  children: ReactNode;
}

export function PanelHost({ workKey, owner, children }: PanelHostProps): JSX.Element {
  const key = ownerKey(owner);
  const panel = useLayoutStore((state) => state.layouts[workKey]?.panels?.[key]);
  const open = panel?.open === true;
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  // Ширина вида вместе с панелью, CSS-пиксели; 0 — ещё не мерили (и jsdom): вид считается широким.
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host === null) return undefined;
    setWidth(host.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const next = entries[entries.length - 1]?.contentRect.width;
      if (next !== undefined) setWidth(next);
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const narrow = width > 0 && width < PANEL_LIMITS.narrowBelow;
  const maxWidth = Math.max(PANEL_LIMITS.minWidth, Math.min(Math.floor(width * PANEL_LIMITS.maxShare), width - PANEL_LIMITS.minView));
  const wanted = Math.max(panel?.width ?? PANEL_LIMITS.defaultWidth, PANEL_LIMITS.minWidth);
  const areaWidth = width > 0 ? Math.min(wanted, maxWidth) : wanted;

  // Стору окна: этот вид хозяина на экране (пока смонтирован) и узок ли он.
  const runtimeKey = panelRuntimeKey(workKey, owner);
  useLayoutEffect(() => () => usePanelRuntime.getState().unmountHost(runtimeKey), [runtimeKey]);
  useLayoutEffect(() => {
    usePanelRuntime.getState().mountHost(runtimeKey, narrow);
  }, [runtimeKey, narrow]);

  // Якоря — через `setProperty`: в `CSSProperties` @types/react 18 их нет (как у `GroupView`). `reserve` — только у участка
  // рядом с видом: терминал отнимает у себя ровно его ширину, а под участком поверх вида остаётся прежним.
  useLayoutEffect(() => {
    const area = areaRef.current;
    if (area === null) return;
    const names = narrow ? [panelAnchor(workKey, owner, 'area')] : [panelAnchor(workKey, owner, 'area'), panelAnchor(workKey, owner, 'reserve')];
    area.style.setProperty('anchor-name', names.join(', '));
  }, [open, narrow, workKey, key]);

  // Вид под панелью поверх него ни фокуса, ни кликов не получает.
  useLayoutEffect(() => {
    viewRef.current?.toggleAttribute('inert', open && narrow);
  }, [open, narrow]);

  return (
    <div ref={hostRef} data-testid="panel-host" className="relative flex h-full min-h-0 w-full min-w-0">
      <div ref={viewRef} className="h-full min-h-0 min-w-0 flex-1">
        {children}
      </div>
      {!open ? null : narrow ? (
        <div ref={areaRef} data-panel-area={key} data-panel-mode="covering" className="absolute inset-0" />
      ) : (
        <>
          <Resizer
            side="right"
            width={areaWidth}
            min={PANEL_LIMITS.minWidth}
            max={maxWidth}
            target={areaRef}
            onCommit={(next) => resizePanel(workKey, owner, next)}
          />
          <div ref={areaRef} data-panel-area={key} data-panel-mode="beside" className="h-full shrink-0" style={{ width: areaWidth }} />
        </>
      )}
    </div>
  );
}
