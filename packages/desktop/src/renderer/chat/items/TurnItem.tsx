/** Конец хода (план 2026-10-01, решение 3): тонкая черта с длительностью. */

import type { FeedTurn } from '@parley/core';
import { S } from '../../../shared/strings.js';
import { formatDuration } from '../../lib/metrics-line.js';

export function TurnItem({ item }: { item: FeedTurn }): JSX.Element {
  const duration = item.durationMs === null ? null : formatDuration(item.durationMs);
  // Прерывание (Esc) — та же черта, но с другой подписью и предупреждающим цветом (живая проверка 2026-10-02).
  const interrupted = item.interrupted === true;
  return (
    <div
      data-testid="chat-turn"
      {...(interrupted ? { 'data-turn-interrupted': '' } : {})}
      className={`flex items-center gap-2 text-[11px] ${interrupted ? 'text-[var(--status-warning-text)]' : 'text-muted-foreground'}`}
    >
      <span className="h-px flex-1 bg-border" />
      <span className="shrink-0">{interrupted ? S.chat.turnInterrupted(duration) : S.chat.turn(duration)}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}
