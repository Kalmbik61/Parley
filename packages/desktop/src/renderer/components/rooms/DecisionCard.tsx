/**
 * Карточка решения (спека окна 2026-09-29, 1.3, 2.4): последней в ленте, пока `Room.proposal` не `null`.
 * До 680px, радиус 16, рамка 1.5px `accent`, фон `accent 9%`, padding `14 16`, зазор 10. Шапка 12px —
 * аватар ведущего, его подпись (600), тег `decision · waiting for you`, время; текст 14px — Markdown (GFM) с
 * чипами (`RoomMarkdown.tsx`).
 * Кнопки `Accept` (главная) и `Return for rework` (второстепенная); после второй вместо кнопок — поле
 * заметки (от 64px, радиус 14) и `Send to lead` / `Cancel`. Пустая заметка допустима (2.4).
 *
 * Ответ хоста — через `onResolve`: `true` — принят, `false` — отказ (причину показал вызывающий тостом,
 * `conflict` тоже: карточка при нём не ломается, живая версия приходит событием карты). Пока ответ на
 * показанную версию (`id` + `rev`) не вернулся, кнопки заняты: второе нажатие `Accept` не даёт второго
 * вызова. После успеха они остаются занятыми, пока карточка не сменится: хост отвечает на повтор
 * `conflict`ом, и человек увидел бы тост о том, чего не было. Новая версия текста (`rev` вырос) заменяет
 * текст на месте, форма возврата и заметка при этом остаются. Форма и заметка переживают и размонтирование
 * вкладки комнаты: с `draftKey` они лежат в `useUiStore.decisionDrafts` (по комнате и id решения, не `rev`).
 * В заметку можно диктовать голосом (микрофон справа от поля, ⌘⇧M в поле); `Send to lead` сперва дожидается конца записи.
 * Пока ответ в пути, в нажатой кнопке крутится спиннер; если хост ещё не открыл снимок работ, под кнопками
 * подпись, что ответ уйдёт после старта (разбор 2026-10-14: после перезапуска Accept висел до 30 с молча).
 */

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { LoaderCircle } from 'lucide-react';
import type { WorkEntry } from '@parley/core';
import type { ParleyBridge } from '../../../shared/bridge.js';
import { useUiStore } from '../../store/ui.js';
import { S } from '../../../shared/strings.js';
import { Badge } from '../../ui/badge.js';
import { Button } from '../../ui/button.js';
import { Textarea } from '../../ui/textarea.js';
import { MicButton } from '../../voice/MicButton.js';
import { useDictationStore } from '../../voice/dictation-store.js';
import { isVoiceShortcut, useTextareaDictation } from '../../voice/targets.js';
import type { ProposalModel } from './feed-model.js';
import { RoomMarkdown } from './RoomMarkdown.js';
import { PlanSummary } from './PlanPanel.js';
import { SenderAvatar } from './SenderAvatar.js';

/** Предел заметки возврата — схема `rooms.resolveProposal` (`note` до 4000 знаков). */
const NOTE_MAX = 4000;

/** Ключ формы возврата в `useUiStore.decisionDrafts`. */
export const decisionDraftKey = (roomDraftKey: string, proposalId: string): string => `${roomDraftKey}\n${proposalId}`;

export interface DecisionCardProps {
  unavailableReason?: string;
  entry?: WorkEntry;
  bridge?: ParleyBridge;
  children?: ReactNode;
  /** Дополнительный выбор пункта при возврате автономного завершения. */
  returnFields?: ReactNode;
  canReturn?: boolean;
  returnReady?: boolean;
  requireReturnNote?: boolean;
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
  /** Хост ответил на `works.list`; `false` — ответ на решение ждёт старта хоста. По умолчанию `true`. */
  hostReady?: boolean;
  /** Ключ черновика комнаты: с ним форма возврата и заметка живут в сторе окна, без него — в состоянии карточки. */
  draftKey?: string;
}

export function DecisionCard({ proposal, time, labelOf, onOpenExternal, canResolve, onResolve, onLayout, children, returnFields, canReturn = true, returnReady = true, requireReturnNote = false, entry, bridge, unavailableReason, hostReady = true, draftKey }: DecisionCardProps): JSX.Element {
  const [localReturning, setLocalReturning] = useState(false);
  const [localNote, setLocalNote] = useState('');
  const storeKey = draftKey === undefined ? null : decisionDraftKey(draftKey, proposal.id);
  const stored = useUiStore((state) => (storeKey === null ? undefined : state.decisionDrafts[storeKey]));
  const returning = storeKey === null ? localReturning : (stored?.open ?? false);
  const note = storeKey === null ? localNote : (stored?.note ?? '');
  const setDraft = (open: boolean, text: string): void => {
    if (storeKey === null) {
      setLocalReturning(open);
      setLocalNote(text);
    } else {
      useUiStore.getState().setDecisionDraft(storeKey, { open, note: text });
    }
  };
  const noteRef = useRef<HTMLTextAreaElement>(null);
  /** Цель диктовки: на карточку своя (комната + решение), пока она смонтирована. */
  const dictationId = `decision-return:${draftKey ?? ''}:${proposal.id}`;
  /** Версия карточки, на которую уже ушёл ответ; `null` — отвечать можно. */
  const [resolving, setResolving] = useState<string | null>(null);
  /** Какое действие в пути — спиннер рисуется в его кнопке. */
  const [pending, setPending] = useState<'accept' | 'return' | null>(null);
  const inFlight = useRef(false);
  const version = [proposal.id, proposal.rev, proposal.planId ?? proposal.plan?.id, proposal.planRev ?? proposal.plan?.rev].join(':');
  const busy = resolving === version;
  const isPlan = proposal.plan !== undefined || proposal.kind === 'completion';
  // Поле есть только при открытой форме; цель регистрируется всегда, `element` вернёт `null` при закрытой.
  useTextareaDictation(dictationId, noteRef, (value) => { if (!busy && canResolve) setDraft(true, value); });

  const layoutRef = useRef(onLayout);
  layoutRef.current = onLayout;
  useLayoutEffect(() => {
    layoutRef.current();
  }, [returning]);

  const answer = async (action: 'accept' | 'return'): Promise<void> => {
    // Второй клик в тот же тик, до перерисовки с занятыми кнопками, вызова не даёт.
    if (inFlight.current || !canResolve || (action === 'return' && (!canReturn || !returnReady || (requireReturnNote && !note.trim())))) return;
    inFlight.current = true;
    setResolving(version);
    setPending(action);
    const accepted = await onResolve(action, action === 'return' ? note.trim() : '');
    inFlight.current = false;
    if (!accepted) setResolving(null);
    else if (storeKey !== null) useUiStore.getState().setDecisionDraft(storeKey, null);
  };

  const spinner = <LoaderCircle data-busy-spinner="" aria-hidden="true" className="size-3.5 animate-spin motion-reduce:animate-none" />;
  const startingNote = busy && !hostReady ? <p data-host-starting="" className="text-xs text-muted-foreground">{S.rooms.hostStarting}</p> : null;

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
        <Badge variant="accent">{proposal.kind === 'completion' ? S.plans.completion : S.rooms.decisionWaiting}</Badge>
        <span className="text-muted-foreground">{time}</span>
      </div>
      {proposal.text.length > 2000 ? (
        <details onToggle={onLayout}><summary>{S.plans.fullText}</summary><RoomMarkdown text={proposal.text} labelOf={labelOf} onOpenExternal={onOpenExternal} /></details>
      ) : <RoomMarkdown text={proposal.text} labelOf={labelOf} onOpenExternal={onOpenExternal} />}
      {proposal.plan ? <><h4>{S.plans.proposed}</h4><PlanSummary plan={proposal.plan} {...(entry ? {entry} : {})} {...(bridge ? {bridge} : {})}/></> : null}
      {children}
      {isPlan && !canResolve ? <p>{unavailableReason ?? S.plans.oldHost}</p> : null}
      {!canResolve && !isPlan ? null : returning ? (
        <div className="flex flex-col gap-2">
          {returnFields}
          <div className="flex items-start gap-2">
            <Textarea
              ref={noteRef}
              disabled={busy || !canResolve}
              value={note}
              onChange={(event) => { if (!busy && canResolve) setDraft(true, event.target.value); }}
              onKeyDown={(event) => {
                if (!isVoiceShortcut(event.nativeEvent)) return;
                event.preventDefault();
                void useDictationStore.getState().toggle(dictationId);
              }}
              placeholder={S.rooms.returnPlaceholder}
              aria-label={S.rooms.returnPlaceholder}
              maxLength={NOTE_MAX}
              className="min-h-16 min-w-0 flex-1 rounded-[14px] border-[color-mix(in_srgb,currentColor_22%,transparent)] bg-[color-mix(in_srgb,currentColor_5%,transparent)]"
            />
            <MicButton targetId={dictationId} size="sm" />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={busy || !canResolve || !canReturn || !returnReady || (requireReturnNote && !note.trim())} onClick={() => {
              // Запись ещё идёт — текст сперва должен лечь в заметку, ответ уйдёт следующим нажатием.
              if (useDictationStore.getState().finishBeforeSend(dictationId)) return;
              void answer('return');
            }}>
              {busy && pending === 'return' ? spinner : null}
              {S.rooms.sendToLead}
            </Button>
            <Button type="button" variant="outline" disabled={busy || !canResolve} onClick={() => setDraft(false, note)}>
              {S.common.cancel}
            </Button>
          </div>
          {startingNote}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={busy || !canResolve} onClick={() => void answer('accept')}>
              {busy && pending === 'accept' ? spinner : null}
              {S.rooms.accept}
            </Button>
            <Button type="button" variant="outline" disabled={busy || !canResolve || !canReturn} onClick={() => setDraft(true, note)}>
              {S.rooms.returnForRework}
            </Button>
          </div>
          {startingNote}
        </>
      )}
    </div>
  );
}
