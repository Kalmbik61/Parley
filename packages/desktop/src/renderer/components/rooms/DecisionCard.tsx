/**
 * Карточка решения (спека окна 2026-09-29, 1.3, 2.4): последней в ленте, пока `Room.proposal` не `null`.
 * До 680px, радиус 16, рамка 1.5px `accent`, фон `accent 9%`, padding `14 16`, зазор 10. Шапка 12px —
 * аватар ведущего, его подпись (600), тег `decision · waiting for you`, время; текст 14px с чипами.
 * Кнопки `Accept` (главная) и `Return for rework` (второстепенная); после второй вместо кнопок — поле
 * заметки (от 64px, радиус 14) и `Send to lead` / `Cancel`. Пустая заметка допустима (2.4).
 *
 * Ответ хоста — через `onResolve`: `true` — принят, `false` — отказ (причину показал вызывающий тостом,
 * `conflict` тоже: карточка при нём не ломается, живая версия приходит событием карты). Пока ответ на
 * показанную версию (`id` + `rev`) не вернулся, кнопки заняты: второе нажатие `Accept` не даёт второго
 * вызова. После успеха они остаются занятыми, пока карточка не сменится: хост отвечает на повтор
 * `conflict`ом, и человек увидел бы тост о том, чего не было. Новая версия текста (`rev` вырос) заменяет
 * текст на месте, форма возврата и заметка при этом остаются.
 */

import { useLayoutEffect, useRef, useState } from 'react';
import { S } from '../../../shared/strings.js';
import { Badge } from '../../ui/badge.js';
import { Button } from '../../ui/button.js';
import { Textarea } from '../../ui/textarea.js';
import type { ProposalModel } from './feed-model.js';
import { MentionText } from './MentionText.js';
import { SenderAvatar } from './SenderAvatar.js';

/** Предел заметки возврата — схема `rooms.resolveProposal` (`note` до 4000 знаков). */
const NOTE_MAX = 4000;

export interface DecisionCardProps {
  proposal: ProposalModel;
  /** Время решения в относительной записи («2m»). */
  time: string;
  labelOf: (sessionId: string) => string | null;
  onOpenExternal: (url: string) => void;
  /** Хост не знает `rooms.resolveProposal` — кнопок нет (протокол только добавляется, спека 3.2). */
  canResolve: boolean;
  onResolve: (action: 'accept' | 'return', note: string) => Promise<boolean>;
  /** Форма возврата поменяла высоту карточки: лента снова прижимается к низу. */
  onLayout: () => void;
}

export function DecisionCard({ proposal, time, labelOf, onOpenExternal, canResolve, onResolve, onLayout }: DecisionCardProps): JSX.Element {
  const [returning, setReturning] = useState(false);
  const [note, setNote] = useState('');
  /** Версия карточки, на которую уже ушёл ответ; `null` — отвечать можно. */
  const [resolving, setResolving] = useState<string | null>(null);
  const inFlight = useRef(false);
  const version = `${proposal.id}:${proposal.rev}`;
  const busy = resolving === version;

  const layoutRef = useRef(onLayout);
  layoutRef.current = onLayout;
  useLayoutEffect(() => {
    layoutRef.current();
  }, [returning]);

  const answer = async (action: 'accept' | 'return'): Promise<void> => {
    // Второй клик в тот же тик, до перерисовки с занятыми кнопками, вызова не даёт.
    if (inFlight.current) return;
    inFlight.current = true;
    setResolving(version);
    const accepted = await onResolve(action, action === 'return' ? note.trim() : '');
    inFlight.current = false;
    if (!accepted) setResolving(null);
  };

  return (
    <div
      data-decision-card=""
      data-proposal-id={proposal.id}
      data-proposal-rev={proposal.rev}
      className="box-border flex max-w-[680px] shrink-0 flex-col gap-2.5 rounded-md border-[1.5px] border-(--color-accent) bg-[color-mix(in_srgb,var(--color-accent)_9%,transparent)] px-4 py-3.5"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs">
        <SenderAvatar kind="agent" provider={proposal.provider} />
        <span className="min-w-0 break-words font-semibold">{proposal.from}</span>
        <Badge variant="accent">{S.rooms.decisionWaiting}</Badge>
        <span className="text-muted-foreground">{time}</span>
      </div>
      <div className="whitespace-pre-wrap break-words text-sm leading-[1.55] [overflow-wrap:anywhere] [text-wrap:pretty]">
        <MentionText text={proposal.text} labelOf={labelOf} onOpenExternal={onOpenExternal} />
      </div>
      {!canResolve ? null : returning ? (
        <div className="flex flex-col gap-2">
          <Textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder={S.rooms.returnPlaceholder}
            aria-label={S.rooms.returnPlaceholder}
            maxLength={NOTE_MAX}
            autoFocus
            className="min-h-16 rounded-[14px] border-[color-mix(in_srgb,currentColor_22%,transparent)] bg-[color-mix(in_srgb,currentColor_5%,transparent)]"
          />
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={busy} onClick={() => void answer('return')}>
              {S.rooms.sendToLead}
            </Button>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setReturning(false)}>
              {S.common.cancel}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={busy} onClick={() => void answer('accept')}>
            {S.rooms.accept}
          </Button>
          <Button type="button" variant="outline" disabled={busy} onClick={() => setReturning(true)}>
            {S.rooms.returnForRework}
          </Button>
        </div>
      )}
    </div>
  );
}
