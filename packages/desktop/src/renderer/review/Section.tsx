/**
 * Сворачиваемая секция «Изменений» (кусок 8.2b, спека 11.1): заголовок-кнопка с числом, под ним
 * строки. `section` с `aria-label` — область, которую находит и чтение с экрана, и тест.
 */

import type { ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

export interface SectionProps {
  title: string;
  count: number;
  open: boolean;
  onToggle(): void;
  children: ReactNode;
}

export function Section({ title, count, open, onToggle, children }: SectionProps): JSX.Element {
  return (
    <section aria-label={title} className="flex min-w-0 flex-col">
      <button
        type="button"
        aria-expanded={open}
        className="flex h-7 w-full min-w-0 items-center gap-1 px-2 text-left text-xs font-medium text-muted-foreground hover:bg-accent"
        onClick={onToggle}
      >
        {open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
        <span className="truncate">{title}</span>
        <span className="ml-auto shrink-0 tabular-nums">{count}</span>
      </button>
      {open ? <ul className="flex min-w-0 flex-col">{children}</ul> : null}
    </section>
  );
}
