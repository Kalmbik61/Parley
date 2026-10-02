/**
 * Служебная строка ленты (план 2026-10-01, решение 3): старт и конец сессии, компакция, смена модели,
 * отчёт субагента. Тонкая и приглушённая, в одну строку — целиком в подсказке.
 */

import type { FeedNotice } from '@parley/core';
import { S } from '../../../shared/strings.js';

export function noticeText(item: FeedNotice): string {
  const notice = item.notice;
  switch (notice.type) {
    case 'session-start':
      return S.chat.notice.sessionStart(notice.source, notice.model);
    case 'session-end':
      return S.chat.notice.sessionEnd(notice.reason);
    case 'compact':
      return notice.phase === 'pre' ? S.chat.notice.compactPre : S.chat.notice.compactPost;
    case 'model-switch':
      return S.chat.notice.modelSwitch(notice.from, notice.to);
    case 'agent-reported':
      return S.chat.notice.agentReported(notice.summary);
  }
}

export function NoticeItem({ item }: { item: FeedNotice }): JSX.Element {
  const text = noticeText(item);
  return (
    <div data-testid="chat-notice" data-notice={item.notice.type} title={text} className="truncate text-xs text-muted-foreground">
      {text}
    </div>
  );
}
