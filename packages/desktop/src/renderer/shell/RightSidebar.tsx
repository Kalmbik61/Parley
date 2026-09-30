/**
 * Правый сайдбар (кусок 7.2, спека 5.1, 10.1): есть только при активной работе, ширина —
 * `ui.rightSidebar` зеркала в пределах 220 … окно − левый − 320 (`fitRightSidebar`, раунд
 * main-r2: не влезает — `AppShell` его не показывает), тот же `Resizer`, что у левого; в
 * `ui.json` ширина уходит на `pointerup`. Сверху — полоса вкладок: «Files» (⌘⇧E) и «Changes»
 * (⌘⇧G, кусок 8.2b) — `tab` из `ui.json`.
 *
 * Вкладка и ширина пишутся только через `setSidebar('right', …)` — `app.saveUi` напрямую не
 * зовётся (2.3). Свёрнутый сайдбар `AppShell` не монтирует вовсе: слежение за корнем снимается.
 *
 * Облик Organic (спека окна 2026-09-29, 1.1, 1.8): сайдбар 320 без подложки и линии — он лежит прямо на
 * фоне окна, отступ `2 12 8 4`, зазор 14; сверху сегмент `Files` / `Changes` (пилюля с рамкой,
 * выбранная опция — на `--primary`). Роли `tablist` и `tab` прежние: сегмент переключает панели, а не
 * значение формы.
 */

import { useEffect, useRef, useState } from 'react';
import type { ParleyBridge } from '../../shared/bridge.js';
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
  bridge: ParleyBridge;
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
        className="flex h-full min-w-0 shrink-0 flex-col gap-3.5 overflow-hidden pb-2 pl-1 pr-3 pt-0.5"
      >
        <div
          role="tablist"
          aria-label={S.titlebar.rightSidebar}
          className="inline-flex shrink-0 items-center self-start overflow-hidden rounded-full border border-border bg-(--color-bg)"
        >
          {TABS.map(({ tab, label }) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={current === tab}
              // Невыбранная опция — основной цвет, а не приглушённый: hover-заливка `text 7%` на фоне
              // окна снижает `--muted-foreground` ниже 4.5:1 (наследство куска 1).
              className="border-l border-border px-3 py-[7px] text-[13px] text-foreground transition-colors first:border-l-0 hover:bg-foreground/7 aria-selected:bg-primary aria-selected:text-primary-foreground aria-selected:hover:bg-primary-hover"
              onClick={() => setSidebar('right', { tab })}
            >
              {label}
            </button>
          ))}
        </div>
        {entry === undefined ? null : current === 'changes' ? (
          <ChangesPanel bridge={bridge} workKey={workKey} entry={entry} sendDeps={sendDeps} />
        ) : (
          // `key` работы (раунд fix-7.4, п. 1): панель другой работы — свой экземпляр, без чужого поиска.
          <FilesPanel key={workKey} bridge={bridge} entry={entry} />
        )}
      </div>
    </>
  );
}
