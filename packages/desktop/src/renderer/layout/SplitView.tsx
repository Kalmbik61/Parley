/**
 * Один узел-сплит дерева раскладки (кусок 2.4, спека 5.2, 5.3): flex-контейнер
 * по `direction`, доля первого ребёнка — `ratio`. Разделитель — та же схема,
 * что и у `shell/Resizer.tsx` (rAF-батч записи в DOM, `setPointerCapture`,
 * сброс на `lostpointercapture`/`blur` окна БЕЗ commit — среда прервала
 * перетаскивание, а не человек отпустил кнопку): во время движения доля
 * пишется прямо в `style.flexBasis` первого ребёнка, `setRatio` стора — только
 * на `pointerup`.
 *
 * Нулевой размер контейнера (jsdom, свёрнутое окно) даёт нечисловую долю —
 * `writeRatio` тогда не трогает DOM вовсе (без `NaN` в стиле), а `setRatio`
 * дерева (`tree.ts`) сам не принимает нечисловой `ratio` и вернёт ту же
 * раскладку той же ссылкой (спека 5.3, тест 16).
 *
 * `NodeView` — общий диспетчер «группа или сплит» для обоих детей: экспортирован
 * отсюда же, а не из `LayoutView.tsx`, чтобы не заводить цикл импортов
 * (`LayoutView` рендерит `SplitView`/`GroupView`, значит сам модуль-диспетчер
 * должен быть НИЖЕ по графу импортов, а не наоборот).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkEntry } from '@parley/core';
import type { LayoutNode, SplitNode } from '../../shared/layout-types.js';
import { cn } from '../lib/cn.js';
import { GroupView } from './GroupView.js';
import { useLayoutStore } from './store.js';
import { LIMITS, setRatio } from './tree.js';

export interface NodeViewProps {
  workKey: string;
  node: LayoutNode;
  entry: WorkEntry;
  /** Единственная группа во всей раскладке работы (спека 5.3) — передаётся дальше без изменений. */
  singleGroup: boolean;
}

export function NodeView({ workKey, node, entry, singleGroup }: NodeViewProps): JSX.Element {
  if (node.type === 'group') return <GroupView workKey={workKey} group={node} entry={entry} singleGroup={singleGroup} />;
  return <SplitView workKey={workKey} node={node} entry={entry} singleGroup={singleGroup} />;
}

export interface SplitViewProps {
  workKey: string;
  node: SplitNode;
  entry: WorkEntry;
  singleGroup: boolean;
}

interface DragStart {
  pointerPos: number;
  startRatio: number;
  /** Ширина (`row`) или высота (`column`) контейнера в момент `pointerdown`; 0 — нечего мерить (тест 16). */
  containerSize: number;
}

export function SplitView({ workKey, node, entry, singleGroup }: SplitViewProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef<DragStart | null>(null);
  const pendingRatio = useRef(node.ratio);
  const rafId = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);

  const isRow = node.direction === 'row';
  const minPx = isRow ? LIMITS.minGroup.width : LIMITS.minGroup.height;

  useEffect(
    () => () => {
      if (rafId.current !== null) cancelAnimationFrame(rafId.current);
    },
    [],
  );

  const writeRatio = (ratio: number): void => {
    pendingRatio.current = ratio;
    if (rafId.current !== null) return;
    rafId.current = requestAnimationFrame(() => {
      rafId.current = null;
      const el = firstRef.current;
      // Нечисловая доля не пишется в DOM вовсе — ни `NaN%`, ни прежнее значение не трогаем.
      if (el === null || !Number.isFinite(pendingRatio.current)) return;
      el.style.flexBasis = `${pendingRatio.current * 100}%`;
    });
  };

  /** Клампит долю пиксельным минимумом группы (спека «Числа»: 240×160) поверх диапазона 0.1–0.9. */
  const clampToPixels = (ratio: number, containerSize: number): number => {
    if (!Number.isFinite(ratio) || containerSize <= 0) return ratio;
    const minRatio = Math.max(LIMITS.ratio.min, minPx / containerSize);
    const maxRatio = Math.min(LIMITS.ratio.max, 1 - minPx / containerSize);
    // Контейнер уже 2×минимума — от клампа один зажат меньше другого; середина безопаснее любого края.
    if (minRatio > maxRatio) return 0.5;
    return Math.min(Math.max(ratio, minRatio), maxRatio);
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const rect = containerRef.current?.getBoundingClientRect();
    const containerSize = rect === undefined ? 0 : isRow ? rect.width : rect.height;
    dragStart.current = { pointerPos: isRow ? event.clientX : event.clientY, startRatio: node.ratio, containerSize };
    pendingRatio.current = node.ratio;
    setDragging(true);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const start = dragStart.current;
    if (start === null) return;
    const pos = isRow ? event.clientX : event.clientY;
    // Размер 0 (jsdom, свёрнутое окно) — доля нечисловая: `x / 0` конечно, но
    // `0 / 0` уже NaN у совпавших координат, а дальше клампу всё равно нечего
    // мерить — отдаём NaN сразу, не подставляя обманчивое «похожее на число».
    const delta = start.containerSize > 0 ? (pos - start.pointerPos) / start.containerSize : Number.NaN;
    writeRatio(clampToPixels(start.startRatio + delta, start.containerSize));
  };

  const resetDragState = useCallback((): void => {
    dragStart.current = null;
    setDragging(false);
    if (rafId.current !== null) {
      cancelAnimationFrame(rafId.current);
      rafId.current = null;
    }
  }, []);

  const endDrag = (): void => {
    if (dragStart.current === null) return;
    const ratio = pendingRatio.current;
    resetDragState();
    useLayoutStore.getState().apply(workKey, (layout) => setRatio(layout, node.id, ratio));
  };

  /** Потеря захвата не отпусканием (среда, не человек) — сброс без `setRatio` (тот только на `pointerup`, как и в `Resizer.tsx`). */
  const cancelDrag = useCallback((): void => {
    if (dragStart.current === null) return;
    resetDragState();
  }, [resetDragState]);

  useEffect(() => {
    if (!dragging) return undefined;
    window.addEventListener('blur', cancelDrag);
    return () => window.removeEventListener('blur', cancelDrag);
  }, [dragging, cancelDrag]);

  return (
    <div ref={containerRef} className={cn('flex h-full min-h-0 min-w-0 flex-1', isRow ? 'flex-row' : 'flex-col')}>
      <div
        ref={firstRef}
        data-testid="split-first"
        style={{ flexBasis: `${node.ratio * 100}%` }}
        className="min-h-0 min-w-0 shrink-0 grow-0 overflow-hidden"
      >
        <NodeView workKey={workKey} node={node.children[0]} entry={entry} singleGroup={singleGroup} />
      </div>
      <div
        role="separator"
        aria-orientation={isRow ? 'vertical' : 'horizontal'}
        className={cn('group relative shrink-0 touch-none select-none', isRow ? 'w-2 cursor-col-resize' : 'h-2 cursor-row-resize')}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={cancelDrag}
      >
        <div
          className={cn(
            'absolute bg-split-divider group-hover:bg-split-divider-strong',
            isRow ? 'inset-y-0 left-1/2 w-[3px] -translate-x-1/2' : 'inset-x-0 top-1/2 h-[3px] -translate-y-1/2',
          )}
        />
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <NodeView workKey={workKey} node={node.children[1]} entry={entry} singleGroup={singleGroup} />
      </div>
      {dragging ? (
        // Тот же приём, что и в `Resizer.tsx`: поверх всего окна, чтобы гостевые
        // поверхности (терминал, будущий `<webview>`) не перехватили мышь по пути.
        <div data-testid="split-resize-overlay" className={cn('fixed inset-0 z-40', isRow ? 'cursor-col-resize' : 'cursor-row-resize')} />
      ) : null}
    </div>
  );
}
