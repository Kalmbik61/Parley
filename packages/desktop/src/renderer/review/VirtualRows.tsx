/**
 * Строки файлов секций «Изменений» фиксированной высоты (раунд fix-final-c, п. 1):
 * в DOM — видимые и запас по краям. `npm install` без `.gitignore` давал тысячи строк на каждое
 * обновление раз в 2 с. Образец — `files/Tree.tsx#VirtualRows`.
 *
 * Прокрутчик бывает общим на несколько списков (секции «Изменений»): отступ списка от начала
 * прокрутчика — `scrollMargin`, он замеряется на каждой отрисовке. Держатель — `li` с вложенным
 * `ul`: строки остаются элементами списка внутри `ul` секции.
 *
 * Прокрутчик приходит элементом, а не ref: он — предок списка, и его ref React ставит уже после
 * эффектов списка. С ref виртуализатор при монтировании не нашёл бы прокрутчик и не слушал бы его
 * прокрутку (замер E2E: строки после прокрутки не менялись). Владелец держит элемент в состоянии
 * (ref-колбэк) — появление прокрутчика перерисовывает список.
 */

import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

/** Высота списка до первого замера (jsdom и первый кадр): первые строки есть сразу, как в сайдбаре. */
const INITIAL_RECT = { width: 320, height: 600 };

export interface VirtualRowsProps<T> {
  scroller: HTMLElement | null;
  items: T[];
  rowHeight: number;
  itemKey(item: T, index: number): string;
  renderRow(item: T, style: CSSProperties): JSX.Element;
}

export function VirtualRows<T>({ scroller, items, rowHeight, itemKey, renderRow }: VirtualRowsProps<T>): JSX.Element {
  const holder = useRef<HTMLLIElement | null>(null);
  const [margin, setMargin] = useState(0);
  useLayoutEffect(() => {
    const node = holder.current;
    if (node === null || scroller === null) return;
    const next = node.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    if (next !== margin) setMargin(next);
  });
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scroller,
    estimateSize: () => rowHeight,
    getItemKey: (index) => {
      const item = items[index];
      return item === undefined ? index : itemKey(item, index);
    },
    scrollMargin: margin,
    initialRect: INITIAL_RECT,
    overscan: 10,
  });
  // Пустой список — ни одного элемента: пустая секция остаётся без строк, как до виртуализации.
  if (items.length === 0) return <></>;
  return (
    <li ref={holder} className="relative w-full min-w-0" style={{ height: virtualizer.getTotalSize() }}>
      <ul>
        {virtualizer.getVirtualItems().map((row) => {
          const item = items[row.index];
          if (item === undefined) return null;
          return renderRow(item, {
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: rowHeight,
            transform: `translateY(${row.start - margin}px)`,
          });
        })}
      </ul>
    </li>
  );
}
