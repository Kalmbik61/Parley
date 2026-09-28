/**
 * Правый сайдбар (кусок 7.2, спека 5.1, 10.1): есть только при активной работе, ширина —
 * `ui.rightSidebar` зеркала в пределах 220 … окно − левый − 320 (`fitRightSidebar`, раунд
 * main-r2: не влезает — `AppShell` его не показывает), тот же `Resizer`, что у левого; в
 * `ui.json` ширина уходит на `pointerup`. Сверху — полоса вкладок: «Files» (⌘⇧E); «Changes»
 * появится в 8.2, а `tab: 'changes'` из `ui.json` до неё показывает «Files».
 *
 * Вкладка и ширина пишутся только через `setSidebar('right', …)` — `app.saveUi` напрямую не
 * зовётся (2.3). Свёрнутый сайдбар `AppShell` не монтирует вовсе: слежение за корнем снимается.
 */

import { useEffect, useRef, useState } from 'react';
import type { HarnasBridge } from '../../shared/bridge.js';
import { S } from '../../shared/strings.js';
import { fitRightSidebar, RIGHT_SIDEBAR } from '../../shared/ui-types.js';
import { FilesPanel } from '../files/FilesPanel.js';
import { workKey as workKeyOf } from '../lib/tree-order.js';
import { useUiStore } from '../store/ui.js';
import { useWorksStore } from '../store/works.js';
import { Resizer } from './Resizer.js';

/** Ширина окна — для верхнего предела сайдбара; `normalizeUi` её не знает (`RIGHT_SIDEBAR`). */
export function useWindowWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = (): void => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
}

/** Место для правого сайдбара сейчас — для ⌘L, ⌘⇧E и кнопки заголовка: без него — тост. */
export function rightSidebarHasRoom(): boolean {
  const { ui } = useUiStore.getState();
  return fitRightSidebar(ui.rightSidebar.width, window.innerWidth, ui.leftSidebar.open ? ui.leftSidebar.width : 0) !== null;
}

export interface RightSidebarProps {
  bridge: HarnasBridge;
  /** Активная работа; без неё `AppShell` сайдбар не рисует. */
  workKey: string;
  /** Показанная ширина и её верхний предел — `fitRightSidebar` в `AppShell`. */
  width: number;
  max: number;
}

export function RightSidebar({ bridge, workKey, width: shown, max }: RightSidebarProps): JSX.Element {
  const setSidebar = useUiStore((state) => state.setSidebar);
  const entry = useWorksStore((state) => state.entries.find((item) => workKeyOf(item.projectPath, item.map.work.id) === workKey));
  const ref = useRef<HTMLDivElement>(null);

  return (
    <>
      <Resizer side="right" width={shown} min={RIGHT_SIDEBAR.min} max={max} target={ref} onCommit={(next) => setSidebar('right', { width: next })} />
      <div
        ref={ref}
        data-testid="right-sidebar"
        style={{ width: shown }}
        className="flex h-full min-w-0 shrink-0 flex-col overflow-hidden border-l border-border bg-card"
      >
        <div role="tablist" aria-label={S.titlebar.rightSidebar} className="flex h-8 shrink-0 items-center gap-1 border-b border-border px-2">
          {/* До 8.2 вкладка одна: «Files» выбрана при любом `tab`, клик пишет `tab: 'files'`. */}
          <button
            type="button"
            role="tab"
            aria-selected
            className="h-6 rounded px-2 text-xs font-medium text-foreground hover:bg-accent"
            onClick={() => setSidebar('right', { tab: 'files' })}
          >
            {S.files.panel}
          </button>
        </div>
        {entry === undefined ? null : <FilesPanel bridge={bridge} entry={entry} />}
      </div>
    </>
  );
}
