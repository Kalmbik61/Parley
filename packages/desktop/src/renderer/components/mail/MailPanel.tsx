/**
 * Панель «вся почта работы» (кусок 2.4 плана окна, спека 5.1, 6.3, 6.4):
 * шапка, блок решений, лента писем. Облик Organic (спека окна 2026-09-29, 1.8): шапка — `Mail` Caprasimo 25
 * и подзаголовок `{работа} · {n} unread` / `all read` (n — письма с точкой), лента — колонка карточек до
 * 640px с зазором 14 и отступами `32 36`. Держит
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

  const unread = view.letters.filter((letter) => letter.unread).length;

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div data-mail-header className="flex shrink-0 items-start justify-between gap-3 px-9 pb-3.5 pt-8">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className="m-0 font-heading text-[25px] leading-[1.12] tracking-[-0.015em]">{S.tabs.mail}</h3>
          <span className="truncate text-[13px] text-muted-foreground">{S.mail.subtitle(entry.map.work.title, unread)}</span>
        </div>
        {below > 0 ? (
          <button
            type="button"
            onClick={scrollToBottom}
            className="shrink-0 rounded-full bg-secondary px-2.5 py-1 text-xs text-foreground"
          >
            ↓{below}
          </button>
        ) : null}
      </div>
      <Decisions decisions={view.decisions} />
      <div ref={containerRef} onScroll={handleScroll} className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-9 pb-8">
        {view.letters.map((letter) => (
          <Letter
            key={letter.id}
            letter={letter}
            variant="card"
            onOpenExternal={onOpenExternal}
            observeRef={markRead(letter.id, isUnreadForHuman(messages.get(letter.id)))}
          />
        ))}
      </div>
    </div>
  );
}
