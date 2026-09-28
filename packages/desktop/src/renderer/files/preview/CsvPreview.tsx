/**
 * Превью CSV и TSV (кусок 7.5, спека 10.6): таблица по `parseCsv`, первая строка — заголовок,
 * первые 10 000 строк данных и первые 200 колонок, виртуализация строк — в DOM только видимые.
 * Предел колонок (fix-7.5): по горизонтали виртуализации нет, и строка из сотен тысяч полей
 * положила бы столько же узлов на каждую видимую строку. Ширина колонок
 * одинаковая, длинное значение обрезается многоточием и целиком видно в подсказке; широкая
 * таблица прокручивается внутри тела, а не раздвигает окно.
 */

import { useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { S } from '../../../shared/strings.js';
import { parseCsv } from './csv.js';

/** Предел строк данных (спека 10.6); заголовок сверх него. */
const MAX_ROWS = 10_000;
/** Предел видимых колонок (fix-7.5). */
const MAX_COLUMNS = 200;
const ROW_HEIGHT = 24;
const COLUMN_WIDTH = 160;

export interface CsvPreviewProps {
  text: string;
  delimiter: ',' | '\t';
}

function Cell({ value, header = false }: { value: string; header?: boolean }): JSX.Element {
  return (
    <div
      role={header ? 'columnheader' : 'cell'}
      title={value}
      className={`truncate border-r border-border px-2 leading-6 ${header ? 'font-medium' : ''}`}
      style={{ width: COLUMN_WIDTH, flex: 'none' }}
    >
      {value}
    </div>
  );
}

export function CsvPreview({ text, delimiter }: CsvPreviewProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { header, rows, truncated, columnsTruncated, columns } = useMemo(() => {
    const parsed = parseCsv(text, delimiter, MAX_ROWS + 1, MAX_COLUMNS);
    const [first = [], ...rest] = parsed.rows;
    const width = parsed.rows.reduce((max, row) => Math.max(max, row.length), 0);
    return { header: first, rows: rest, truncated: parsed.truncated, columnsTruncated: parsed.columnsTruncated, columns: width };
  }, [text, delimiter]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });
  const width = columns * COLUMN_WIDTH;
  const fill = (row: string[]): string[] => Array.from({ length: columns }, (_, index) => row[index] ?? '');

  return (
    <div data-testid="csv-preview" className="flex h-full min-h-0 min-w-0 flex-col text-xs">
      {truncated ? (
        <div className="shrink-0 truncate border-b border-border px-3 py-1 text-muted-foreground">{S.files.rowsTruncated}</div>
      ) : null}
      {columnsTruncated ? (
        <div className="shrink-0 truncate border-b border-border px-3 py-1 text-muted-foreground">{S.files.columnsTruncated}</div>
      ) : null}
      <div ref={scrollRef} role="table" className="min-h-0 flex-1 overflow-auto">
        <div role="row" className="sticky top-0 z-10 flex border-b border-border bg-background" style={{ width }}>
          {fill(header).map((value, index) => (
            <Cell key={index} value={value} header />
          ))}
        </div>
        <div className="relative" style={{ width, height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            if (row === undefined) return null;
            return (
              <div
                key={item.key}
                role="row"
                className="absolute top-0 left-0 flex border-b border-border"
                style={{ width, height: ROW_HEIGHT, transform: `translateY(${item.start}px)` }}
              >
                {fill(row).map((value, index) => (
                  <Cell key={index} value={value} />
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
