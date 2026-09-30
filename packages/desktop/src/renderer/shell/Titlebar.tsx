/**
 * Заголовок окна, 40px (кусок 2.3, спека Orca-UI 4.4, 5.1; геометрия Organic — спека окна 2026-09-29,
 * 1.1): светофор macOS слева (отступ 80px под него держит `pl-20`, сама позиция — `trafficLightPosition`
 * в `main/window.ts`), дальше — сайдбар работ и история переходов; справа — «правый сайдбар» (⌘L,
 * с 7.2 — только при активной работе). У заголовка нет ни подложки, ни линии: он лежит прямо на фоне
 * окна, а центр ниже — лист со скруглением.
 *
 * Левая зона по ширине равна сайдбару (пока он открыт): строка вкладок начинается над краем листа, а
 * не где придётся. Сайдбар скрыт — зона по содержимому. Сама зона — область перетаскивания окна, а
 * `titlebar-no-drag` лежит только на кнопках внутри неё: иначе за пустое место зоны окно не утащить.
 * Ширину зоны задаёт состояние `ui.leftSidebar`, поэтому за ресайзом сайдбара она идёт по его
 * отпусканию, а не на каждом кадре перетаскивания (`Resizer` двигает ширину сайдбара прямо в DOM).
 *
 * Слот `#titlebar-tabs` — сам он пуст всегда: строку вкладок в него портали­рует
 * `layout/TabStrip.tsx` (кусок 2.4), когда в активной работе ровно одна группа
 * (спека 5.3); при нескольких группах строка остаётся пустой, вкладки рисуются
 * над телом каждой группы. `titlebar-no-drag` на слоте — по спеке 5.1, вкладкам
 * не приходится думать об этом самим.
 *
 * Поиск (палитра ⌘J) живёт в сайдбаре — строка `Search`; в заголовке он остаётся только там, где
 * сайдбара нет на экране (`showSearch`: сайдбар скрыт или окно без работ, `Landing`): без него мышью
 * палитру можно было бы открыть лишь через «+» строки вкладок. Открытый сайдбар поиск не дублирует —
 * в снимках handoff у заголовка справа только кнопка правого сайдбара.
 */

import { ArrowLeft, ArrowRight, PanelLeft, PanelRight, Search } from 'lucide-react';
import { toast } from 'sonner';
import type { HarnasBridge } from '../../shared/bridge.js';
import { S } from '../../shared/strings.js';
import { useLayoutStore } from '../layout/store.js';
import { cn } from '../lib/cn.js';
import { usePaletteStore } from '../palette/store.js';
import { useUiStore } from '../store/ui.js';
import { rightSidebarHasRoom } from './RightSidebar.js';

export interface TitlebarProps {
  bridge: HarnasBridge;
  /** Показать поиск справа: сайдбара с его строкой `Search` на экране нет (решает `AppShell`). */
  showSearch?: boolean;
}

/** Двойной клик по вложенной кнопке/полю не должен долетать до заголовка как «клик по пустому месту». */
function stopDoubleClick(event: React.MouseEvent): void {
  event.stopPropagation();
}

/**
 * Кнопка заголовка (1.1): пилюля 28×28, значок 15, hover `text 8%`, active `text 14%`; недоступная —
 * прозрачность .45. Цвет значка — `neutral-800`. Включённое состояние (`aria-pressed`) — фон `text 10%`.
 */
const TITLE_BUTTON = cn(
  'inline-flex size-7 shrink-0 items-center justify-center rounded-full text-neutral-800 transition-colors',
  'hover:bg-foreground/8 active:bg-foreground/14 disabled:pointer-events-none disabled:opacity-45',
  'aria-pressed:bg-foreground/10 aria-pressed:hover:bg-foreground/10',
);

export function Titlebar({ bridge, showSearch = false }: TitlebarProps): JSX.Element {
  const leftOpen = useUiStore((state) => state.ui.leftSidebar.open);
  const leftWidth = useUiStore((state) => state.ui.leftSidebar.width);
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
      className="titlebar-drag flex h-10 shrink-0 items-center gap-1.5 pr-2.5 text-sm text-foreground"
      onDoubleClick={() => bridge.app.titlebarDoubleClick()}
    >
      <div
        data-testid="titlebar-left"
        className="flex shrink-0 items-center pl-20"
        style={leftOpen ? { width: leftWidth } : undefined}
      >
        <div className="titlebar-no-drag flex items-center gap-0.5" onDoubleClick={stopDoubleClick}>
          <button
            type="button"
            className={TITLE_BUTTON}
            aria-label={S.titlebar.toggleSidebar}
            onClick={() => setSidebar('left', { open: !leftOpen })}
          >
            <PanelLeft className="size-[15px]" aria-hidden="true" />
          </button>
          <button type="button" className={TITLE_BUTTON} aria-label={S.titlebar.back} disabled={!canBack} onClick={back}>
            <ArrowLeft className="size-[15px]" aria-hidden="true" />
          </button>
          <button
            type="button"
            className={TITLE_BUTTON}
            aria-label={S.titlebar.forward}
            disabled={!canForward}
            onClick={forward}
          >
            <ArrowRight className="size-[15px]" aria-hidden="true" />
          </button>
        </div>
      </div>

      <div id="titlebar-tabs" className="titlebar-no-drag min-w-0 flex-1" onDoubleClick={stopDoubleClick} />

      <div className="titlebar-no-drag flex items-center gap-1" onDoubleClick={stopDoubleClick}>
        {showSearch ? (
          <button
            type="button"
            onClick={() => openPalette('default')}
            className="flex h-7 items-center gap-2 rounded-full bg-secondary px-3 text-xs text-muted-foreground hover:bg-foreground/8 hover:text-accent-foreground"
          >
            <Search className="size-3.5" aria-hidden="true" />
            {S.titlebar.search}
            <kbd className="rounded-full bg-neutral-200 px-[7px] py-0.5 font-sans text-[10px] text-neutral-800">⌘J</kbd>
          </button>
        ) : null}
        <button
          type="button"
          className={TITLE_BUTTON}
          aria-label={S.titlebar.rightSidebar}
          aria-pressed={hasActiveWork && rightOpen}
          disabled={!hasActiveWork}
          onClick={() => {
            // Нет места рядом с центром — тост, как у ⌘L (раунд main-r2, п. 7).
            if (!rightSidebarHasRoom()) toast(S.errors.noRoomForRightSidebar);
            else setSidebar('right', { open: !rightOpen });
          }}
        >
          <PanelRight className="size-[15px]" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
