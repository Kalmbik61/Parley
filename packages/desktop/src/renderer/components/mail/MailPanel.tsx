/**
 * Панель «вся почта работы» (кусок 2.4 плана окна, спека 5.1, 6.3, 6.4):
 * шапка со счётом писем и участниками, блок решений, лента писем. Держит
 * хвост ленты, пока пользователь не ушёл прокруткой вверх — тогда позицию не
 * трогает, а в шапке растёт `↓N` (столько писем пришло, пока он читал историю).
 *
 * jsdom (тесты) не считает раскладку сам, но `scrollTop`/`scrollHeight`/
 * `clientHeight` у него — обычные читаемые/писаемые свойства элемента, так что
 * этот же код проверяется без реального рендера (`MailPanel.test.ts`).
 */

import { useLayoutEffect, useRef, useState } from 'react';
import type { Message, WorkEntry } from '@harnas/core';
import type { HarnasBridge } from '../../../shared/bridge.js';
import { S } from '../../../shared/strings.js';
import { isHumanUnread } from '../../attention/derive.js';
import { useMarkRead } from '../../attention/use-mark-read.js';
import { mailView } from '../../lib/mail-view.js';
import { Decisions } from './Decisions.js';
import { Letter } from './Letter.js';

export interface MailPanelProps {
  entry: WorkEntry;
  providers: Array<{ id: string; label: string }>;
  models: Record<string, string | null>;
  bridge: HarnasBridge;
  /** Работа активна (`LayoutBodyContext.active`): письма скрытой работы LRU не отмечаются прочитанными. */
  active: boolean;
  onOpenExternal: (url: string) => void;
}

/** Ушёл ли пользователь от хвоста ленты дальше, чем на пиксельный люфт округления. */
const BOTTOM_SLACK = 8;

/** Письмо из карты не прочитано человеком; пропавшее из карты — не кандидат. */
function isUnreadForHuman(message: Message | undefined): boolean {
  return message !== undefined && isHumanUnread(message);
}

function isAtBottom(container: HTMLDivElement): boolean {
  return container.scrollHeight - container.scrollTop - container.clientHeight <= BOTTOM_SLACK;
}

export function MailPanel({ entry, providers, models, bridge, active, onOpenExternal }: MailPanelProps): JSX.Element {
  const view = mailView(entry, providers, models);
  const markRead = useMarkRead({ bridge, projectPath: entry.projectPath, workId: entry.map.work.id, active });
  const messages = new Map(entry.map.messages.map((message) => [message.id, message]));
  const containerRef = useRef<HTMLDivElement | null>(null);
  // У хвоста лента держится всегда, пока читатель сам не отступил прокруткой —
  // `ref`, а не состояние: значение нужно синхронно внутри layout-эффекта и
  // обработчика скролла, а перерисовка панели из-за него не нужна.
  const stuckToBottomRef = useRef(true);
  const previousCountRef = useRef(view.letters.length);
  const [below, setBelow] = useState(0);

  useLayoutEffect(() => {
    const added = view.letters.length - previousCountRef.current;
    previousCountRef.current = view.letters.length;

    const container = containerRef.current;
    if (container === null) return;

    if (stuckToBottomRef.current) {
      container.scrollTop = container.scrollHeight;
      setBelow(0);
    } else if (added > 0) {
      // Пользователь ушёл вверх — позицию не трогаем, счёт новых писем растёт.
      setBelow((count) => count + added);
    }
  }, [view.letters.length]);

  const handleScroll = (): void => {
    const container = containerRef.current;
    if (container === null) return;
    const atBottom = isAtBottom(container);
    stuckToBottomRef.current = atBottom;
    if (atBottom) setBelow(0);
  };

  const scrollToBottom = (): void => {
    const container = containerRef.current;
    if (container === null) return;
    container.scrollTop = container.scrollHeight;
    stuckToBottomRef.current = true;
    setBelow(0);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">
            {S.mail.headerPrefix} · {view.letters.length} {S.mail.messageWord(view.letters.length)}
          </div>
          <div className="truncate text-xs text-muted-foreground">{view.participants.join(' · ')}</div>
        </div>
        {below > 0 ? (
          <button
            type="button"
            onClick={scrollToBottom}
            className="shrink-0 rounded bg-muted px-2 py-1 text-xs text-foreground"
          >
            ↓{below}
          </button>
        ) : null}
      </div>
      <Decisions decisions={view.decisions} />
      <div ref={containerRef} onScroll={handleScroll} className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {view.letters.map((letter) => (
          <Letter
            key={letter.id}
            letter={letter}
            onOpenExternal={onOpenExternal}
            observeRef={markRead(letter.id, isUnreadForHuman(messages.get(letter.id)))}
          />
        ))}
      </div>
    </div>
  );
}
