/**
 * Дифф вызова `Edit`/`Write` в ленте (план 2026-10-01, решение 10): хунки `structuredPatch` с номерами
 * строк слева и справа и цветами `+`/`−` из токенов ревью (`--diff-added-*`, `--git-decoration-*`).
 * Строки одной высоты — виртуальный список в своём прокрутчике с пределом высоты: дифф на тысячи
 * строк держит в DOM только видимые, а элемент ленты не растёт выше `MAX_HEIGHT_PX`.
 *
 * В светлой теме подложки `+` и `−` почти не различимы, поэтому у добавленных и удалённых строк —
 * цветная полоса слева тем же цветом, что знак (`--git-decoration-*`); у строк контекста — прозрачная
 * той же ширины, чтобы колонки не съезжали. Номера строк и заголовок `@@` — `foreground/70`, а не
 * muted: на подложках диффа muted бледнеет (`styles/tokens.test.ts`, «дифф ленты чата»).
 */

import { useMemo, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { FeedPatchHunk } from '@parley/core';
import { cn } from '../../lib/cn.js';

const ROW_PX = 18;
const MAX_HEIGHT_PX = 320;
/** Размер прокрутчика до первого замера (jsdom и первый кадр). */
const INITIAL_RECT = { width: 640, height: MAX_HEIGHT_PX };

type DiffRow =
  | { kind: 'hunk'; text: string }
  | { kind: 'line'; sign: ' ' | '-' | '+'; text: string; oldNo: number | null; newNo: number | null };

/** Хунки → строки: заголовок `@@ -a,b +c,d @@` и строки с номерами старого и нового файла. */
export function diffRows(hunks: readonly FeedPatchHunk[]): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const hunk of hunks) {
    rows.push({ kind: 'hunk', text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@` });
    let oldNo = hunk.oldStart;
    let newNo = hunk.newStart;
    for (const line of hunk.lines) {
      const head = line.charAt(0);
      const text = line.slice(1);
      if (head === '-') rows.push({ kind: 'line', sign: '-', text, oldNo: oldNo++, newNo: null });
      else if (head === '+') rows.push({ kind: 'line', sign: '+', text, oldNo: null, newNo: newNo++ });
      // `\ No newline at end of file` и прочее без префикса — строка контекста без номеров.
      else if (head === ' ') rows.push({ kind: 'line', sign: ' ', text, oldNo: oldNo++, newNo: newNo++ });
      else rows.push({ kind: 'line', sign: ' ', text: line, oldNo: null, newNo: null });
    }
  }
  return rows;
}

const ROW_TONE = {
  ' ': 'border-l-2 border-transparent',
  '-': 'border-l-2 border-[var(--git-decoration-deleted)] bg-[var(--diff-removed-ground)]',
  '+': 'border-l-2 border-[var(--git-decoration-added)] bg-[var(--diff-added-ground)]',
} as const;

const SIGN_TONE = {
  ' ': 'text-muted-foreground',
  '-': 'text-[var(--git-decoration-deleted)]',
  '+': 'text-[var(--git-decoration-added)]',
} as const;

/** Знак строки на экране: минус — настоящий «−», как в ревью. */
const SIGN_TEXT = { ' ': ' ', '-': '−', '+': '+' } as const;

export function DiffHunks({ hunks }: { hunks: readonly FeedPatchHunk[] }): JSX.Element {
  const rows = useMemo(() => diffRows(hunks), [hunks]);
  // Прокрутчик — элементом в состоянии: виртуализатор должен увидеть его уже при монтировании.
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller,
    estimateSize: () => ROW_PX,
    initialRect: INITIAL_RECT,
    overscan: 20,
  });
  const total = rows.length * ROW_PX;
  return (
    <div
      ref={setScroller}
      data-testid="chat-diff"
      className="overflow-auto rounded-sm border border-border font-mono text-xs"
      style={{ height: Math.min(total, MAX_HEIGHT_PX) + 2 }}
    >
      <div className="relative w-full" style={{ height: total }}>
        {virtualizer.getVirtualItems().map((virtual) => {
          const row = rows[virtual.index];
          if (row === undefined) return null;
          const style = { height: ROW_PX, transform: `translateY(${virtual.start}px)` };
          if (row.kind === 'hunk') {
            return (
              <div
                key={virtual.key}
                data-diff-row="hunk"
                className="absolute left-0 top-0 min-w-full w-max whitespace-pre bg-muted px-2 leading-[18px] text-foreground/70"
                style={style}
              >
                {row.text}
              </div>
            );
          }
          return (
            <div
              key={virtual.key}
              data-diff-row={row.sign === ' ' ? 'context' : row.sign === '+' ? 'added' : 'removed'}
              className={cn('absolute left-0 top-0 flex min-w-full w-max whitespace-pre leading-[18px]', ROW_TONE[row.sign])}
              style={style}
            >
              <span className="w-10 shrink-0 select-none pr-1 text-right text-foreground/70">{row.oldNo ?? ''}</span>
              <span className="w-10 shrink-0 select-none pr-1 text-right text-foreground/70">{row.newNo ?? ''}</span>
              <span className={cn('w-4 shrink-0 select-none text-center', SIGN_TONE[row.sign])}>{SIGN_TEXT[row.sign]}</span>
              <span className="pr-3">{row.text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
