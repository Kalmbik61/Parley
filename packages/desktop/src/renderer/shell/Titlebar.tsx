/**
 * Заголовок окна, 36px (кусок 2.3, спека 4.4, 5.1): светофор macOS слева
 * (отступ 80px под него держит `pl-20`, сама позиция — `trafficLightPosition`
 * в `main/window.ts`), дальше — сайдбар работ и история переходов; справа —
 * поиск (палитра ⌘K) и заглушка правого сайдбара (появится в 7.2).
 *
 * Слот `#titlebar-tabs` — пока пустой: строку вкладок в него порталит 2.4,
 * когда в активной работе ровно одна группа (спека 5.3). Уже сейчас у него
 * `titlebar-no-drag`, как требует спека 5.1, — вкладкам, когда они появятся,
 * не придётся про это думать самим.
 */

import { ArrowLeft, ArrowRight, PanelLeft, PanelRight, Search } from 'lucide-react';
import type { HarnasBridge } from '../../shared/bridge.js';
import { useLayoutStore } from '../layout/store.js';
import { useUiStore } from '../store/ui.js';
import { Button } from '../ui/button.js';

export interface TitlebarProps {
  bridge: HarnasBridge;
}

/** Двойной клик по вложенной кнопке/полю не должен долетать до заголовка как «клик по пустому месту». */
function stopDoubleClick(event: React.MouseEvent): void {
  event.stopPropagation();
}

export function Titlebar({ bridge }: TitlebarProps): JSX.Element {
  const leftOpen = useUiStore((state) => state.ui.leftSidebar.open);
  const setSidebar = useUiStore((state) => state.setSidebar);
  const setPaletteOpen = useUiStore((state) => state.setPaletteOpen);

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
          aria-label="Сайдбар работ"
          onClick={() => setSidebar('left', { open: !leftOpen })}
        >
          <PanelLeft className="size-3.5" />
        </Button>
        <Button type="button" variant="ghost" size="icon-xs" aria-label="Назад" disabled={!canBack} onClick={back}>
          <ArrowLeft className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Вперёд"
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
          onClick={() => setPaletteOpen(true)}
          className="flex h-6 items-center gap-1.5 rounded-md border border-input bg-background px-2 text-xs text-muted-foreground hover:bg-accent"
        >
          <Search className="size-3.5" />
          Поиск
          <kbd className="rounded border border-border px-1 text-[10px]">⌘K</kbd>
        </button>
        <Button type="button" variant="ghost" size="icon-xs" aria-label="Правый сайдбар" disabled>
          <PanelRight className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
