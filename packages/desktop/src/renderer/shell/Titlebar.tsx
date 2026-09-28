/**
 * Заголовок окна, 36px (кусок 2.3, спека 4.4, 5.1): светофор macOS слева
 * (отступ 80px под него держит `pl-20`, сама позиция — `trafficLightPosition`
 * в `main/window.ts`), дальше — сайдбар работ и история переходов; справа —
 * поиск (палитра ⌘J) и «правый сайдбар» (⌘L, с 7.2 — только при активной работе).
 *
 * Слот `#titlebar-tabs` — сам он пуст всегда: строку вкладок в него портали­рует
 * `layout/TabStrip.tsx` (кусок 2.4), когда в активной работе ровно одна группа
 * (спека 5.3); при нескольких группах строка остаётся пустой, вкладки рисуются
 * над телом каждой группы. `titlebar-no-drag` на слоте — по спеке 5.1, вкладкам
 * не приходится думать об этом самим.
 */

import { ArrowLeft, ArrowRight, PanelLeft, PanelRight, Search } from 'lucide-react';
import { toast } from 'sonner';
import type { HarnasBridge } from '../../shared/bridge.js';
import { S } from '../../shared/strings.js';
import { useLayoutStore } from '../layout/store.js';
import { usePaletteStore } from '../palette/store.js';
import { useUiStore } from '../store/ui.js';
import { Button } from '../ui/button.js';
import { rightSidebarHasRoom } from './RightSidebar.js';

export interface TitlebarProps {
  bridge: HarnasBridge;
}

/** Двойной клик по вложенной кнопке/полю не должен долетать до заголовка как «клик по пустому месту». */
function stopDoubleClick(event: React.MouseEvent): void {
  event.stopPropagation();
}

export function Titlebar({ bridge }: TitlebarProps): JSX.Element {
  const leftOpen = useUiStore((state) => state.ui.leftSidebar.open);
  const rightOpen = useUiStore((state) => state.ui.rightSidebar.open);
  // Правый сайдбар есть только при активной работе (кусок 7.2): без неё кнопка неактивна.
  const hasActiveWork = useLayoutStore((state) => state.activeWorkKey !== null);
  const setSidebar = useUiStore((state) => state.setSidebar);
  const openPalette = usePaletteStore((state) => state.openWith);

  const back = useLayoutStore((state) => state.back);
  const forward = useLayoutStore((state) => state.forward);
  // Вызов метода стора внутри селектора — тот же приём, что и у `canBack`/
  // `canForward` в `layout/store.ts`: обе функции читают `history` через
  // замыкание, а не аргументом, поэтому zustand умеет решить, изменился ли
  // результат, только пересчитав его на каждое обновление стора.
  const canBack = useLayoutStore((state) => state.canBack());
  const canForward = useLayoutStore((state) => state.canForward());

  return (
    <div
      data-testid="titlebar"
      className="titlebar-drag flex h-9 shrink-0 items-center border-b border-border bg-card pl-20 pr-2 text-sm text-foreground"
      onDoubleClick={() => bridge.app.titlebarDoubleClick()}
    >
      <div className="titlebar-no-drag flex items-center gap-0.5" onDoubleClick={stopDoubleClick}>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={S.titlebar.toggleSidebar}
          onClick={() => setSidebar('left', { open: !leftOpen })}
        >
          <PanelLeft className="size-3.5" />
        </Button>
        <Button type="button" variant="ghost" size="icon-xs" aria-label={S.titlebar.back} disabled={!canBack} onClick={back}>
          <ArrowLeft className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={S.titlebar.forward}
          disabled={!canForward}
          onClick={forward}
        >
          <ArrowRight className="size-3.5" />
        </Button>
      </div>

      <div id="titlebar-tabs" className="titlebar-no-drag min-w-0 flex-1" onDoubleClick={stopDoubleClick} />

      <div className="titlebar-no-drag flex items-center gap-1" onDoubleClick={stopDoubleClick}>
        <button
          type="button"
          onClick={() => openPalette('default')}
          className="flex h-6 items-center gap-1.5 rounded-md border border-input bg-background px-2 text-xs text-muted-foreground hover:bg-accent"
        >
          <Search className="size-3.5" />
          {S.titlebar.search}
          <kbd className="rounded border border-border px-1 text-[10px]">⌘J</kbd>
        </button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={S.titlebar.rightSidebar}
          aria-pressed={hasActiveWork && rightOpen}
          disabled={!hasActiveWork}
          onClick={() => {
            // Нет места рядом с центром — тост, как у ⌘L (раунд main-r2, п. 7).
            if (!rightSidebarHasRoom()) toast(S.errors.noRoomForRightSidebar);
            else setSidebar('right', { open: !rightOpen });
          }}
        >
          <PanelRight className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
