/**
 * Свёрнутая работа агента в законченном ходе (план 2026-10-30): заголовок-кнопка «Read files, ran commands…».
 * Закрытая группа держит в DOM текстовую тень своих элементов под `hidden="until-found"`: поиск по странице её
 * найдёт, и событие `beforematch` раскроет группу. Тень — только текст: ни кнопок, ни картинок.
 * Открытая группа тени не держит — её элементы идут следом отдельными строками ленты.
 */

import { useLayoutEffect, useRef } from 'react';
import { ChevronRight } from 'lucide-react';
import type { FeedItem } from '@parley/core';
import { cn } from '../../lib/cn.js';
import { toolHeadline } from '../feed-model.js';

export interface ProcessGroupProps {
  title: string;
  open: boolean;
  items: readonly FeedItem[];
  onToggle: () => void;
}

/** Строка тени: что бы ни показал элемент, одной строкой простого текста. */
export function shadowLine(item: FeedItem): string | null {
  switch (item.kind) {
    case 'tool': {
      const headline = toolHeadline(item.name, item.input);
      return headline.summary === null ? headline.name : `${headline.name} ${headline.summary}`;
    }
    case 'agent':
      return item.description ?? item.agentType ?? item.prompt;
    case 'text':
      return item.text;
    case 'error':
      return item.message ?? item.error;
    default:
      return null;
  }
}

export function ProcessGroup({ title, open, items, onToggle }: ProcessGroupProps): JSX.Element {
  const shadow = useRef<HTMLDivElement | null>(null);
  const toggleRef = useRef(onToggle);
  toggleRef.current = onToggle;
  // В JSX тень скрыта булевым `hidden` (с первой отрисовки, без вспышки и ложного замера высоты), а значение
  // `until-found` React 18 не принимает — переключаем через ref до кадра.
  useLayoutEffect(() => {
    const node = shadow.current;
    if (open || node === null) return;
    node.setAttribute('hidden', 'until-found');
    const reveal = (): void => toggleRef.current();
    node.addEventListener('beforematch', reveal);
    return () => node.removeEventListener('beforematch', reveal);
  }, [open]);
  return (
    <div data-testid="chat-process-group" data-open={open ? '' : undefined} className="flex min-w-0 flex-col">
      <button
        type="button"
        aria-expanded={open}
        title={title}
        onClick={onToggle}
        className="flex h-7 w-full min-w-0 items-center gap-2 rounded-sm px-1.5 text-left text-sm text-muted-foreground hover:bg-foreground/7"
      >
        <ChevronRight className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{title}</span>
      </button>
      {open ? null : (
        <div ref={shadow} hidden data-testid="chat-process-shadow">
          {items.map((item) => {
            const line = shadowLine(item);
            return line === null ? null : <p key={item.id} className="m-0">{line}</p>;
          })}
        </div>
      )}
    </div>
  );
}
