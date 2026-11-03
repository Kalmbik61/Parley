/**
 * Пункт Board в навигации сайдбара: открывает вкладку доски; справа — число карточек в Review (бейдж),
 * пока хост умеет доску.
 */

import { Kanban } from 'lucide-react';
import { S } from '../../shared/strings.js';
import { reviewCount } from '../board/board-model.js';
import { useBoardProjects, useBoardStore } from '../board/board-store.js';
import { badgeVariants } from '../ui/badge.js';

export function BoardNavItem({ onOpen, className }: { onOpen(): void; className: string }): JSX.Element {
  const supported = useBoardStore((state) => state.supported);
  const review = reviewCount(useBoardProjects());
  return (
    <button type="button" onClick={onOpen} className={className}>
      <Kanban className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="flex-1 text-left">{S.board.title}</span>
      {/* Бейдж — `span`, а не `Badge`: тот рисует `div`, а в кнопке допустим только поток фраз. */}
      {supported && review > 0 ? (
        <span className={badgeVariants({ variant: 'accent' })} aria-label={S.board.reviewWaiting(review)}>
          {review}
        </span>
      ) : null}
    </button>
  );
}
