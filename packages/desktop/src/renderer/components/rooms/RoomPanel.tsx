/**
 * Панель одной комнаты (спека окна 2026-09-29, 1.3, 2.2–2.4; кусок 6 плана): шапка с лентой участников,
 * лента сообщений с блоком `Decisions` первым, поле ввода с упоминаниями. Данные — `buildRoomModel`
 * (`feed-model.ts`), рисуют `RoomHeader`, `RoomMessage` и `Composer`.
 *
 * Прочтение — существующий механизм писем человеку (`attention/use-mark-read.ts`): сообщение, чья
 * строка меты видна ≥1 с при активной работе, фокусе окна и видимом документе, уходит в `mail.markRead`
 * (пачка через 500 мс тишины); карта отвечает, точка гаснет. Прокрутка — к низу при открытии и при каждом
 * новом сообщении. В отличие от «всей почты» (`MailPanel.tsx`) счёта «↓N» тут нет: комната короче и
 * читается по ходу переписки.
 */

import { useLayoutEffect, useRef } from 'react';
import { toast } from 'sonner';
import type { WorkEntry } from '@harnas/core';
import type { HarnasBridge } from '../../../shared/bridge.js';
import { decodeIpcError } from '../../../shared/ipc-error.js';
import { S, errorText } from '../../../shared/strings.js';
import { useMarkRead } from '../../attention/use-mark-read.js';
import { sessionRowLabel } from '../../lib/participant.js';
import { workKey } from '../../lib/tree-order.js';
import { useNow } from '../../lib/use-now.js';
import type { ActivityEntry } from '../../store/activity.js';
import { composerDraftKey } from '../../store/ui.js';
import { Decisions } from '../mail/Decisions.js';
import { Composer, type ComposerSubmission } from './Composer.js';
import { buildRoomModel } from './feed-model.js';
import { RoomHeader } from './RoomHeader.js';
import { RoomMessage } from './RoomMessage.js';

export interface RoomPanelProps {
  entry: WorkEntry;
  roomId: string;
  providers: Array<{ id: string; label: string }>;
  /** Живая активность сессий (`useActivityStore.byRef`): состояния в ленте участников и в меню упоминаний. */
  activity: Record<string, ActivityEntry>;
  bridge: HarnasBridge;
  /** Работа активна (`LayoutBodyContext.active`): сообщения скрытой работы LRU не отмечаются прочитанными. */
  active: boolean;
  onOpenExternal: (url: string) => void;
  /** Клик по карточке участника: открыть терминал его сессии. */
  onOpenSession: (sessionId: string) => void;
}

/** Относительное время сообщений («2m») обновляется раз в столько же, что и в сайдбаре. */
const NOW_PERIOD_MS = 30_000;

export function RoomPanel({ entry, roomId, providers, activity, bridge, active, onOpenExternal, onOpenSession }: RoomPanelProps): JSX.Element {
  const model = buildRoomModel({ entry, roomId, providers, activity });
  // Хуки — до раннего выхода «комнаты нет»: порядок хуков не должен зависеть от данных.
  const markRead = useMarkRead({ bridge, projectPath: entry.projectPath, workId: entry.map.work.id, active });
  const now = useNow(NOW_PERIOD_MS);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Лента прижата к низу при открытии и когда приходит новое сообщение.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (container !== null) container.scrollTop = container.scrollHeight;
  }, [model?.messages.length]);

  if (model === null) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{S.rooms.notFound}</div>;
  }

  /** Ярлык участника для чипа в тексте; сессии нет в карте — `null`, чип берёт тег из id. */
  const labelOf = (sessionId: string): string | null => {
    const session = entry.map.sessions.find((candidate) => candidate.id === sessionId);
    return session === undefined ? null : sessionRowLabel(sessionId, session.label);
  };

  // Упомянуть можно живую сессию комнаты: закрытая письма не получит.
  const members = model.participants.filter((participant) => !participant.closed);
  const draftKey = composerDraftKey(workKey(entry.projectPath, entry.map.work.id), roomId);

  const handleSend = (submission: ComposerSubmission): Promise<void> =>
    bridge
      .call('rooms.send', {
        projectPath: entry.projectPath,
        workId: entry.map.work.id,
        roomId,
        to: submission.to,
        text: submission.text,
        kind: 'note',
      })
      .then(
        () => undefined,
        (error: unknown) => {
          // Не ушло (не участник, хост недоступен…): человек узнаёт об этом, а поле ввода вернёт текст.
          toast(errorText(decodeIpcError(error).code, S.rooms.sendAction));
          throw error;
        },
      );

  return (
    <div data-room-panel="" className="flex h-full min-h-0 min-w-0 flex-col">
      <RoomHeader title={model.title} subtitle={model.subtitle} participants={model.participants} onOpenSession={onOpenSession} />
      <div ref={containerRef} data-room-feed="" className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-9 py-[18px]">
        <Decisions decisions={model.decisions} className="max-w-[680px]" />
        {model.empty ? <p className="m-0 text-sm text-muted-foreground">{S.rooms.emptyFeed}</p> : null}
        {model.messages.map((message) => (
          <RoomMessage
            key={message.id}
            message={message}
            now={now}
            labelOf={labelOf}
            onOpenExternal={onOpenExternal}
            observeRef={markRead(message.id, message.needsRead)}
          />
        ))}
      </div>
      <Composer key={draftKey} members={members} draftKey={draftKey} onSend={handleSend} />
    </div>
  );
}
