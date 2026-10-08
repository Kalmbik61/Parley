/**
 * Ручка высоты панели Console | Network (спека 2026-10-07-browser-devtools-agent-design.md, 4.3) — по образцу
 * `shell/Resizer.tsx`:
 * - во время перетаскивания высота пишется прямо в DOM, в `ui.json` — только на `pointerup`;
 * - поверх всего — прозрачный оверлей, иначе страница `<webview>` перехватила бы мышь;
 * - потеря захвата и уход фокуса окна прерывают перетаскивание без записи и возвращают прежнюю высоту в DOM.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { S } from '../../../shared/strings.js';

export interface HeightResizerProps {
  height: number;
  min: number;
  max: number;
  /** Чью высоту двигать в DOM во время перетаскивания. */
  target: RefObject<HTMLElement>;
  /** Только на `pointerup`. */
  onCommit(height: number): void;
}

export function HeightResizer({
  height,
  min,
  max,
  target,
  onCommit,
}: HeightResizerProps): JSX.Element {
  const start = useRef<{ y: number; height: number } | null>(null);
  const pending = useRef(height);
  const [dragging, setDragging] = useState(false);

  const cancel = useCallback((): void => {
    start.current = null;
    setDragging(false);
  }, []);

  // Прервали не мы, а среда: в `ui.json` ничего не ушло, значит и в DOM остаётся прежняя высота — иначе окно
  // показывало бы то, чего нет в сохранённом (React не перезапишет style, пока проп `height` не изменится).
  const abort = useCallback((): void => {
    const from = start.current;
    if (from === null) return;
    cancel();
    if (target.current !== null) target.current.style.height = `${from.height}px`;
  }, [cancel, target]);

  useEffect(() => {
    if (!dragging) return undefined;
    window.addEventListener('blur', abort);
    return () => window.removeEventListener('blur', abort);
  }, [dragging, abort]);

  const end = (): void => {
    if (start.current === null) return;
    cancel();
    onCommit(pending.current);
  };

  return (
    <>
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label={S.browser.devtools.resize}
        className="absolute inset-x-0 -top-1.5 z-10 h-3 cursor-row-resize touch-none select-none"
        onPointerDown={(event) => {
          // `setPointerCapture` в jsdom может не быть — без него перетаскивание живёт, пока зажата кнопка.
          event.currentTarget.setPointerCapture?.(event.pointerId);
          start.current = { y: event.clientY, height };
          pending.current = height;
          setDragging(true);
        }}
        onPointerMove={(event) => {
          const from = start.current;
          if (from === null) return;
          // Вверх — выше: панель растёт от нижнего края вкладки.
          const next = Math.min(Math.max(from.height + (from.y - event.clientY), min), max);
          pending.current = next;
          if (target.current !== null) target.current.style.height = `${next}px`;
        }}
        onPointerUp={end}
        onPointerCancel={end}
        onLostPointerCapture={abort}
      />
      {dragging ? (
        <div data-testid="resize-overlay" className="fixed inset-0 z-40 cursor-row-resize" />
      ) : null}
    </>
  );
}
