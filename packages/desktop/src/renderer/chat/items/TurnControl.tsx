/**
 * Строка статуса законченного хода (план 2026-10-30): «Completed in 2m 31s» / «Stopped» / «Failed» вместо черты
 * «Turn finished». Ход с группами работы — кнопка: раскрывает все его группы или сворачивает обратно; без групп — статичная строка.
 */

import { ChevronRight } from 'lucide-react';
import { cn } from '../../lib/cn.js';
import { turnStatusText, type TurnStatus } from '../turn-fold.js';

export interface TurnControlProps {
  status: TurnStatus;
  durationMs: number | null;
  /** В ходе есть группы работы — строка становится кнопкой. */
  hasGroups: boolean;
  /** Все группы хода раскрыты. */
  open: boolean;
  onToggle: () => void;
}

const TONE: Record<TurnStatus, string> = {
  completed: 'text-muted-foreground',
  stopped: 'text-[var(--status-warning-text)]',
  failed: 'text-destructive',
};

export function TurnControl({ status, durationMs, hasGroups, open, onToggle }: TurnControlProps): JSX.Element {
  const label = turnStatusText(status, durationMs);
  const common = {
    'data-testid': 'chat-turn',
    'data-turn-status': status,
    ...(status === 'stopped' ? { 'data-turn-interrupted': '' } : {}),
  };
  const line = <span className="h-px flex-1 bg-border" />;
  if (!hasGroups) {
    return (
      <div {...common} className={cn('flex items-center gap-2 text-[11px]', TONE[status])}>
        {line}
        <span className="shrink-0">{label}</span>
        {line}
      </div>
    );
  }
  return (
    <button
      type="button"
      {...common}
      aria-expanded={open}
      onClick={onToggle}
      className={cn('flex w-full items-center gap-2 rounded-sm text-[11px] hover:bg-foreground/7', TONE[status])}
    >
      {line}
      <ChevronRight className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')} aria-hidden="true" />
      <span className="shrink-0">{label}</span>
      {line}
    </button>
  );
}
