/**
 * Сворачиваемая секция «Изменений» (кусок 8.2b, спека 11.1): заголовок-кнопка с числом, под ним
 * строки. `section` с `aria-label` — область, которую находит и чтение с экрана, и тест.
 *
 * Облик Organic (спека окна 2026-09-29, 1.8): заголовок — пилюля с заливкой hover `text 6 %`; правый
 * сайдбар лежит на фоне окна, а `--muted-foreground` на этой заливке ниже 4.5:1 (наследство куска 1), поэтому на
 * hover текст заголовка — основной цвет (`hover:text-accent-foreground`).
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
        className="flex h-7 w-full min-w-0 items-center gap-1.5 rounded-full px-3 text-left text-xs font-semibold text-muted-foreground transition-colors hover:bg-foreground/6 hover:text-accent-foreground"
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
