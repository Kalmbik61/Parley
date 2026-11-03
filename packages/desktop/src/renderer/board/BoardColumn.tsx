/** Колонка доски: название, число и прокручиваемый список карточек. */
import type { ReactNode } from 'react';

export function BoardColumn({ title, count, top, children }: { title: string; count: number; top?: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <section className="flex min-h-0 w-[264px] shrink-0 flex-col gap-2" aria-label={title}>
      <h3 className="flex items-baseline gap-1.5 px-1 text-sm font-medium">
        <span className="truncate">{title}</span>
        <span className="text-xs text-muted-foreground" data-board-count>{count}</span>
      </h3>
      {top}
      <ul className="scrollbar-sleek flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">{children}</ul>
    </section>
  );
}
