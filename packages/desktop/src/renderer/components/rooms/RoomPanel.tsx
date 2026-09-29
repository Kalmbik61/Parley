/**
 * Панель одной комнаты (кусок 3.6 плана окна, спека 5.1, 6.3): шапка с
 * названием и участниками, блок решений, лента писем, поле ввода. Хвост
 * ленты держится тем же приёмом, что и в `MailPanel.tsx` (кусок 2.4): своя
 * копия, а не общий хук — `MailPanel.tsx` этот кусок не трогает, а вводить
 * абстракцию ради одного дополнительного места рано.
 */

import { useLayoutEffect, useRef } from 'react';
import { toast } from 'sonner';
import type { WorkEntry, WorkMap } from '@harnas/core';
import type { HarnasBridge } from '../../../shared/bridge.js';
import { decodeIpcError } from '../../../shared/ipc-error.js';
import { S, errorText } from '../../../shared/strings.js';
import { isHumanUnread } from '../../attention/derive.js';
import { useMarkRead } from '../../attention/use-mark-read.js';
import { roomView } from '../../lib/room-view.js';
import { workKey } from '../../lib/tree-order.js';
import type { ActivityEntry } from '../../store/activity.js';
import { composerDraftKey } from '../../store/ui.js';
import { Decisions } from '../mail/Decisions.js';
import { Letter } from '../mail/Letter.js';
import { Composer, type ComposerSubmission } from './Composer.js';
import { buildRoomModel } from './feed-model.js';
import { RoomHeader } from './RoomHeader.js';

export interface RoomPanelProps {
  entry: WorkEntry;
  roomId: string;
  providers: Array<{ id: string; label: string }>;
  models: Record<string, string | null>;
  /** Живая активность сессий (`useActivityStore.byRef`): слово состояния в меню упоминаний. */
  activity: Record<string, ActivityEntry>;
  bridge: HarnasBridge;
  /** Работа активна (`LayoutBodyContext.active`): сообщения скрытой работы LRU не отмечаются прочитанными. */
  active: boolean;
  onOpenExternal: (url: string) => void;
}

/** Сообщение карты не прочитано человеком; пропавшее из карты — не кандидат. */
function isUnreadInMap(map: WorkMap, messageId: string): boolean {
  const message = map.messages.find((candidate) => candidate.id === messageId);
  return message !== undefined && isHumanUnread(message);
}

export function RoomPanel({ entry, roomId, providers, models, activity, bridge, active, onOpenExternal }: RoomPanelProps): JSX.Element {
  const view = roomView(entry, roomId, providers, models);
  // Хук — до раннего выхода «комнаты нет»: порядок хуков не должен зависеть от данных.
  const markRead = useMarkRead({ bridge, projectPath: entry.projectPath, workId: entry.map.work.id, active });
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Хвост ленты держится всегда, как только приходит новое письмо — в отличие
  // от «всей почты работы» (`MailPanel.tsx`), тут нет отдельного счёта «↓N»:
  // комната обычно короче и активнее читается прямо по ходу переписки.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    container.scrollTop = container.scrollHeight;
  }, [view?.letters.length]);

  if (view === null) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{S.rooms.notFound}</div>;
  }

  // Упомянуть можно живую сессию комнаты: закрытая письма не получит.
  const members = (buildRoomModel({ entry, roomId, providers, activity })?.participants ?? []).filter((participant) => !participant.closed);
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
    <div className="flex h-full flex-col">
      <RoomHeader title={view.title} participants={view.participants} />
      <Decisions decisions={view.decisions} />
      <div ref={containerRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {view.letters.map((letter) => (
          <Letter
            key={letter.id}
            letter={letter}
            onOpenExternal={onOpenExternal}
            observeRef={markRead(letter.id, isUnreadInMap(entry.map, letter.id))}
          />
        ))}
      </div>
      <Composer key={draftKey} members={members} draftKey={draftKey} onSend={handleSend} />
    </div>
  );
}
