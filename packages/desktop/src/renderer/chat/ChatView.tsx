/**
 * Вид «Chat» вкладки сессии (план 2026-10-01, Task 3) — каркас подкуска 3a: тулбар с сегментом и
 * область ленты. Область пока — простой список «kind — id» по строке на элемент; виртуальный список
 * с элементами по решениям 3 и 10 ставит подкусок 3b на место `FeedArea`.
 *
 * Подписку на ленту держит слой поверхностей (`FeedSubscription` в `SurfaceLayer.tsx`), здесь лента
 * только читается. Поверхности терминала в этом виде нет (решение контролёра Ж), поэтому «видимость»
 * сессии для «просмотрено» и уведомлений (`attention/seen.ts`) ставит сам вид — как `TerminalSurface`.
 * Карточки разрешения, вопроса и плана — одной строкой «ждёт ответа», без кнопок: решения в окне —
 * кусок 4 (решение контролёра И).
 */

import { useEffect } from 'react';
import type { FeedItem } from '@parley/core';
import { refKey, type SessionRef } from '@parley/protocol';
import { S } from '../../shared/strings.js';
import type { TerminalTab } from '../lib/feed-view.js';
import { useUiStore } from '../store/ui.js';
import { ChatToolbar } from './ChatToolbar.js';
import type { FeedEntry } from './store.js';
import { useFeed } from './use-feed.js';

export interface ChatViewProps {
  workKey: string;
  tab: TerminalTab;
  sessionRef: SessionRef;
  /** Работа активна; вкладка активна в группе по построению — тело рисуется только у активной. */
  visible: boolean;
}

export function ChatView({ workKey, tab, sessionRef, visible }: ChatViewProps): JSX.Element {
  const feed = useFeed(sessionRef);

  const sessionKey = refKey(sessionRef);
  useEffect(() => {
    useUiStore.getState().setSessionVisible(sessionKey, visible);
  }, [sessionKey, visible]);
  useEffect(() => () => useUiStore.getState().setSessionVisible(sessionKey, false), [sessionKey]);

  return (
    <div data-testid="chat-view" className="flex h-full min-h-0 w-full flex-col">
      <ChatToolbar workKey={workKey} tabId={tab.id} view="chat" available />
      <FeedArea feed={feed} />
    </div>
  );
}

/** Карточка ждёт решения человека. */
function waiting(item: FeedItem): boolean {
  return (item.kind === 'permission' || item.kind === 'question' || item.kind === 'plan') && item.state === 'pending';
}

/** Временная область ленты подкуска 3a. */
function FeedArea({ feed }: { feed: FeedEntry | null }): JSX.Element {
  const items = feed?.items ?? [];
  let note: string | null = null;
  if (feed?.status === 'error') note = S.chat.feedUnavailable;
  else if (items.length === 0) note = feed === null || feed.status === 'loading' ? S.chat.loading : S.chat.empty;

  return (
    <div data-testid="chat-feed" className="min-h-0 flex-1 overflow-auto px-4 py-3 text-sm">
      {note === null ? null : <p className="m-0 text-muted-foreground">{note}</p>}
      <ul className="m-0 list-none p-0">
        {items.map((item) => (
          <li key={item.id} data-feed-id={item.id} className="truncate font-mono text-xs leading-6">
            {`${item.kind} — ${item.id}`}
            {waiting(item) ? <span className="ml-2 text-muted-foreground">{S.chat.waiting}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
