/**
 * Значок контекста в шапке комнаты (спека 2026-10-15, 3.3): `Ctx 82%` — наибольший процент среди живых участников,
 * `⏳` — есть ждущие просьбы. Поповер: участники с полосой и процентом, Compact / Cancel в строке, спящие — `asleep`
 * без кнопки; одно общее поле инструкции для строк и `Compact all`. Старый хост без поля `context` — значка нет.
 */

import { useState } from 'react';
import { toast } from 'sonner';
import type { ParleyBridge } from '../../../shared/bridge.js';
import { S } from '../../../shared/strings.js';
import { useHostSupports } from '../../lib/capabilities.js';
import { cn } from '../../lib/cn.js';
import {
  BAR_CLASS,
  COMPACT_MAX_INSTRUCTIONS,
  contextChipText,
  contextLevel,
  LEVEL_CLASS,
  maxContext,
  percentText,
} from '../../lib/context-format.js';
import { Button } from '../../ui/button.js';
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover.js';
import { Textarea } from '../../ui/textarea.js';
import { cancelCompaction, compactSession } from '../context/compact-actions.js';
import type { ParticipantModel } from './feed-model.js';

const C = S.context;

export interface RoomContextChipProps {
  bridge: ParleyBridge;
  roomTitle: string;
  participants: readonly ParticipantModel[];
}

export function RoomContextChip({ bridge, roomTitle, participants }: RoomContextChipProps): JSX.Element | null {
  const supported = useHostSupports('sessions.compact');
  const members = participants.filter((participant) => !participant.closed && participant.sessionRef !== undefined);
  const live = members.filter((participant) => participant.lifecycle === 'active');
  if (!live.some((participant) => participant.context !== undefined)) return null;
  const max = maxContext(live.map((participant) => participant.context));
  const level = max === null ? 'normal' : contextLevel(max);
  const queued = live.some((participant) => participant.compaction === 'pending');
  const text = `${C.roomChip(max === null ? C.marks.unknown : percentText(max))}${queued ? ` ${C.marks.pending}` : ''}`;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="xs"
          variant="outline"
          data-testid="room-context-chip"
          data-level={level}
          className={cn('shrink-0 font-mono tabular-nums', LEVEL_CLASS[level])}
        >
          {text}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" data-testid="room-context-popover" className="w-[min(360px,calc(100vw-32px))] p-3 text-xs">
        <RoomContextBody bridge={bridge} roomTitle={roomTitle} members={members} supported={supported} />
      </PopoverContent>
    </Popover>
  );
}

/** Тело поповера: монтируется при открытии, поэтому поле каждый раз начинается с текста по умолчанию. */
function RoomContextBody({
  bridge,
  roomTitle,
  members,
  supported,
}: {
  bridge: ParleyBridge;
  roomTitle: string;
  members: readonly ParticipantModel[];
  supported: boolean;
}): JSX.Element {
  const [text, setText] = useState(C.roomDefault(roomTitle));
  const instructions = text.trim() === '' ? null : text;
  const hasCodex = members.some((participant) => participant.provider === 'codex');

  const compactAll = async (): Promise<void> => {
    const targets = members.filter((participant) => participant.lifecycle === 'active');
    const results = await Promise.all(
      targets.map((participant) => compactSession(bridge, participant.sessionRef!, participant.label, instructions, { quiet: true })),
    );
    const started = results.filter((result) => result?.state === 'started').length;
    const queued = results.filter((result) => result?.state === 'pending').length;
    toast(C.allResult(started, queued, members.length - started - queued));
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 font-medium">{C.roomTitle}</p>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {members.map((participant) => {
          const fill = participant.context ?? null;
          const phase = participant.compaction ?? null;
          const rowLevel = fill === null ? 'normal' : contextLevel(fill.usedPercent);
          return (
            <li key={participant.id} data-context-row={participant.id} className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate" title={participant.label}>
                {participant.label}
              </span>
              {participant.lifecycle === 'active' ? (
                <>
                  <span className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-[color-mix(in_srgb,currentColor_12%,transparent)]">
                    <span className={cn('block h-full', BAR_CLASS[rowLevel])} style={{ width: `${fill?.usedPercent ?? 0}%` }} />
                  </span>
                  <span className="w-[4.5rem] shrink-0 text-right font-mono tabular-nums">{contextChipText(fill, phase)}</span>
                  {!supported ? null : phase === 'pending' ? (
                    <Button type="button" size="xs" variant="outline" onClick={() => void cancelCompaction(bridge, participant.sessionRef!)}>
                      {C.cancel}
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      disabled={phase === 'running'}
                      onClick={() => void compactSession(bridge, participant.sessionRef!, participant.label, instructions)}
                    >
                      {C.compact}
                    </Button>
                  )}
                </>
              ) : (
                <span className="shrink-0 text-muted-foreground">{C.marks.asleep}</span>
              )}
            </li>
          );
        })}
      </ul>
      {supported ? (
        <>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">{C.instructionsLabel}</span>
            <Textarea
              data-testid="room-compact-instructions"
              value={text}
              maxLength={COMPACT_MAX_INSTRUCTIONS}
              rows={4}
              onChange={(event) => setText(event.target.value)}
              className="resize-none text-xs"
            />
          </label>
          {hasCodex ? <p className="m-0 text-muted-foreground">{C.codexNoFocus}</p> : null}
          <div className="flex justify-end">
            <Button type="button" size="xs" data-testid="room-compact-all" onClick={() => void compactAll()}>
              {C.compactAll}
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
