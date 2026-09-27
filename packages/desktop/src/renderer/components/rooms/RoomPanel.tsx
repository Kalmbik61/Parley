/**
 * Панель одной комнаты (кусок 3.6 плана окна, спека 5.1, 6.3): шапка с
 * названием и участниками, блок решений, лента писем, поле ввода. Хвост
 * ленты держится тем же приёмом, что и в `MailPanel.tsx` (кусок 2.4): своя
 * копия, а не общий хук — `MailPanel.tsx` этот кусок не трогает, а вводить
 * абстракцию ради одного дополнительного места рано.
 */

import { useLayoutEffect, useRef } from 'react';
import type { WorkEntry, WorkMap } from '@harnas/core';
import type { HarnasBridge } from '../../../shared/bridge.js';
import { roomView } from '../../lib/room-view.js';
import { participantTag } from '../../lib/participant-tag.js';
import { Decisions } from '../mail/Decisions.js';
import { Letter } from '../mail/Letter.js';
import { Composer, type ComposerMember, type ComposerSubmission } from './Composer.js';
import { RoomHeader } from './RoomHeader.js';

export interface RoomPanelProps {
  entry: WorkEntry;
  roomId: string;
  providers: Array<{ id: string; label: string }>;
  models: Record<string, string | null>;
  bridge: HarnasBridge;
  onOpenExternal: (url: string) => void;
}

/** Закрытая сессия или уже удалённая — недоступна как адресат (спека 6.3). */
function isClosed(map: WorkMap, id: string): boolean {
  const session = map.sessions.find((candidate) => candidate.id === id);
  return session === undefined || session.lifecycle === 'closed';
}

export function RoomPanel({ entry, roomId, providers, models, bridge, onOpenExternal }: RoomPanelProps): JSX.Element {
  const view = roomView(entry, roomId, providers, models);
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
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Комната не найдена</div>;
  }

  const members: ComposerMember[] = view.memberIds.map((id) => ({
    id,
    label: participantTag(entry.map, id, models[id] ?? null, providers),
    closed: isClosed(entry.map, id),
  }));

  const handleSend = (submission: ComposerSubmission): void => {
    bridge
      .call('rooms.send', {
        projectPath: entry.projectPath,
        workId: entry.map.work.id,
        roomId,
        to: submission.to,
        text: submission.text,
        kind: submission.kind,
      })
      .catch(() => {
        // Ошибку (лимит `messageRate`, не участник и т. п.) поле ввода пока не
        // показывает — сообщение просто не уходит, так же, как терминал не
        // показывает ответ хоста построчно.
      });
  };

  return (
    <div className="flex h-full flex-col">
      <RoomHeader title={view.title} participants={view.participants} />
      <Decisions decisions={view.decisions} />
      <div ref={containerRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {view.letters.map((letter) => (
          <Letter key={letter.id} letter={letter} onOpenExternal={onOpenExternal} />
        ))}
      </div>
      <Composer members={members} onSend={handleSend} />
    </div>
  );
}
