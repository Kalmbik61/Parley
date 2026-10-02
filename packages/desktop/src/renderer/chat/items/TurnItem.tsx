/** Конец хода (план 2026-10-01, решение 3): тонкая черта с длительностью. */

import type { FeedTurn } from '@parley/core';
import { S } from '../../../shared/strings.js';
import { formatDuration } from '../../lib/metrics-line.js';

export function TurnItem({ item }: { item: FeedTurn }): JSX.Element {
  return (
    <div data-testid="chat-turn" className="flex items-center gap-2 text-[11px] text-muted-foreground">
      <span className="h-px flex-1 bg-border" />
      <span className="shrink-0">{S.chat.turn(item.durationMs === null ? null : formatDuration(item.durationMs))}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}
