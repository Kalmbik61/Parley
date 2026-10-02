/**
 * Вид «Chat» вкладки сессии (план 2026-10-01, Task 3): тулбар (сегмент, модель, Stop), лента
 * (`FeedList`) и поле ввода (`Composer`).
 *
 * Подписку на ленту держит слой поверхностей (`FeedSubscription` в `SurfaceLayer.tsx`), здесь лента
 * только читается. Поверхности терминала в этом виде нет (решение контролёра Ж), поэтому «видимость»
 * сессии для «просмотрено» и уведомлений (`attention/seen.ts`) ставит сам вид — как `TerminalSurface`.
 * Карточки разрешения, вопроса и плана — одной строкой «ждёт ответа», без кнопок: решения в окне —
 * кусок 4 (решение контролёра И).
 *
 * Ввод (решение 8): текст уходит `pty.send` с `submit: true` через `sendWithToast` — те же отказы и
 * тосты, что у отправки из комнаты и ревью. Отправленное во время хода показывается в ленте серым,
 * пока не придёт промпт с тем же текстом, или до отказа отправки. «Stop» — Esc агенту (`pty.input`).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { FeedItem } from '@parley/core';
import { refKey, type SessionRef } from '@parley/protocol';
import type { ParleyBridge } from '../../shared/bridge.js';
import { S } from '../../shared/strings.js';
import type { TerminalTab } from '../lib/feed-view.js';
import { useUiStore } from '../store/ui.js';
import { sendWithToast, type SendWithToastDeps } from '../terminal/send.js';
import { ChatEnvContext, type ChatEnv } from './chat-env.js';
import { ChatToolbar } from './ChatToolbar.js';
import { Composer } from './Composer.js';
import { currentModel, turnActive } from './feed-model.js';
import { FeedList, type QueuedPrompt } from './FeedList.js';
import type { FeedEntry } from './store.js';
import { useFeed } from './use-feed.js';

export interface ChatViewProps {
  workKey: string;
  tab: TerminalTab;
  sessionRef: SessionRef;
  /** Работа активна; вкладка активна в группе по построению — тело рисуется только у активной. */
  visible: boolean;
  bridge: ParleyBridge;
  /** `SendWithToastDeps` окна (из `AppShell` через раскладку). */
  sendDeps: SendWithToastDeps;
}

const NO_ITEMS: readonly FeedItem[] = [];

/** Ждущее сообщение и сколько промптов с тем же текстом было в ленте, когда оно ушло. */
interface Queued extends QueuedPrompt {
  seen: number;
}

function promptCount(items: readonly FeedItem[], text: string): number {
  const wanted = text.trim();
  return items.filter((item) => item.kind === 'prompt' && item.text.trim() === wanted).length;
}

function noteOf(feed: FeedEntry | null): string | null {
  if (feed?.status === 'error') return S.chat.feedUnavailable;
  if (feed === null || feed.status === 'loading') return S.chat.loading;
  return S.chat.empty;
}

export function ChatView({ workKey, tab, sessionRef, visible, bridge, sendDeps }: ChatViewProps): JSX.Element {
  const feed = useFeed(sessionRef);
  const items = feed?.items ?? NO_ITEMS;
  const active = turnActive(items);
  const model = currentModel(items);

  const sessionKey = refKey(sessionRef);
  useEffect(() => {
    useUiStore.getState().setSessionVisible(sessionKey, visible);
  }, [sessionKey, visible]);
  useEffect(() => () => useUiStore.getState().setSessionVisible(sessionKey, false), [sessionKey]);

  const [queued, setQueued] = useState<Queued[]>([]);
  const nextId = useRef(0);
  // Настоящий промпт с тем же текстом пришёл — серый элемент уходит.
  useEffect(() => {
    setQueued((was) => {
      const left = was.filter((entry) => promptCount(items, entry.text) <= entry.seen);
      return left.length === was.length ? was : left;
    });
  }, [items]);

  const submit = (text: string): void => {
    const id = String((nextId.current += 1));
    if (active) setQueued((was) => [...was, { id, text, seen: promptCount(items, text) }]);
    void sendWithToast(sendDeps, sessionRef, text, true).then((outcome) => {
      if (!('error' in outcome) && outcome.submitted) return;
      // Отказ или вставка без Enter: в очередь CLI сообщение не попало.
      setQueued((was) => was.filter((entry) => entry.id !== id));
    });
  };

  const stop = (): void => bridge.notify('pty.input', { ref: sessionRef, data: '\x1b' });
  const env = useMemo<ChatEnv>(() => ({ bridge, sessionRef }), [bridge, sessionKey]);

  return (
    <ChatEnvContext.Provider value={env}>
      <div data-testid="chat-view" className="flex h-full min-h-0 w-full min-w-0 flex-col">
        <ChatToolbar
          workKey={workKey}
          tabId={tab.id}
          view="chat"
          available
          model={model}
          {...(active ? { onStop: stop } : {})}
        />
        <FeedList items={items} queued={queued} note={noteOf(feed)} />
        <Composer busy={active} onSubmit={submit} />
      </div>
    </ChatEnvContext.Provider>
  );
}
