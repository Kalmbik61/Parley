/**
 * Правый сайдбар (кусок 7.2, спека 5.1, 10.1): есть только при активной работе, ширина —
 * `ui.rightSidebar` зеркала в пределах 220 … окно − левый − 320 (`fitRightSidebar`, раунд
 * main-r2: не влезает — `AppShell` его не показывает), тот же `Resizer`, что у левого; в
 * `ui.json` ширина уходит на `pointerup`. Сверху — полоса вкладок: «Files» (⌘⇧E) и «Changes»
 * (⌘⇧G, кусок 8.2b) — `tab` из `ui.json`.
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
import { ChangesPanel } from '../review/ChangesPanel.js';
import { useUiStore } from '../store/ui.js';
import { useWorksStore } from '../store/works.js';
import type { SendWithToastDeps } from '../terminal/send.js';
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
  /** `SendWithToastDeps` окна (7.2) — «Попросить агента разрешить» во вкладке «Изменения». */
  sendDeps: SendWithToastDeps;
}

const TABS = [
  { tab: 'files', label: S.files.panel },
  { tab: 'changes', label: S.changes.panel },
] as const;

export function RightSidebar({ bridge, workKey, width: shown, max, sendDeps }: RightSidebarProps): JSX.Element {
  const setSidebar = useUiStore((state) => state.setSidebar);
  const current = useUiStore((state) => state.ui.rightSidebar.tab);
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
          {TABS.map(({ tab, label }) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={current === tab}
              className="h-6 rounded px-2 text-xs font-medium text-muted-foreground hover:bg-accent aria-selected:text-foreground"
              onClick={() => setSidebar('right', { tab })}
            >
              {label}
            </button>
          ))}
        </div>
        {entry === undefined ? null : current === 'changes' ? (
          <ChangesPanel bridge={bridge} workKey={workKey} entry={entry} sendDeps={sendDeps} />
        ) : (
          <FilesPanel bridge={bridge} entry={entry} />
        )}
      </div>
    </>
  );
}
