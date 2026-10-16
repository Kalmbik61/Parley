/**
 * Большой вид помощника на острове (спека 2026-10-14, 8.2; эталон — island-mockup.html): знак, подпись состояния,
 * последний вопрос и ответ, карточка подтверждения, строка ввода.
 */

import { useEffect, useState } from 'react';
import { Mic, MicOff } from 'lucide-react';
import type { AssistantState } from '@parley/protocol';
import { S } from '../../../shared/strings.js';
import { AssistantMark } from '../../components/AssistantMark.js';
import { Button } from '../../ui/button.js';
import { hotkeyLabel, statusLabel } from './labels.js';
import { assistantBusy, type InputPhase } from './store.js';

export interface AssistantViewProps {
  host: AssistantState;
  input: InputPhase;
  draft: string;
  notice: string | null;
  cardError: string | null;
  hotkey: string;
  /** Ждущие запросы одобрения: первая сессия и сколько всего. */
  pending: { name: string; total: number } | null;
  onDraft(text: string): void;
  onSubmit(text: string): void;
  onMic(): void;
  onDecide(decision: 'send' | 'cancel'): void;
  onShowRequests(): void;
}

/** Как `CARD_ARM_MS` острова: кнопки карточки взводятся не сразу — случайный клик у края экрана не отправит. */
const ARM_MS = 500;

function useArmed(key: string | null): boolean {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    setArmed(false);
    if (key === null) return;
    const timer = setTimeout(() => setArmed(true), ARM_MS);
    return () => clearTimeout(timer);
  }, [key]);
  return armed;
}

export function AssistantView(props: AssistantViewProps): JSX.Element {
  const { host, input, draft, pending } = props;
  const proposal = host.proposal;
  const armed = useArmed(proposal?.id ?? null);
  const busy = assistantBusy({ host, input });
  const submit = (): void => {
    if (draft.trim() === '' && proposal !== null && armed) props.onDecide('send');
    else props.onSubmit(draft);
  };
  return (
    <div data-testid="assistant-view" className="island-reveal flex w-[420px] flex-col gap-2 px-3 pb-3 pt-1.5 text-sm">
      {pending === null ? null : (
        <button type="button" data-testid="assistant-pending" className="flex cursor-pointer items-center gap-2 self-start rounded px-1 text-[13px] text-foreground/80 hover:bg-white/10" onClick={props.onShowRequests}>
          <span className="size-[7px] rounded-full bg-[var(--color-accent)]" />
          {S.assistant.needsYou(pending.name, pending.total)}
        </button>
      )}
      <div className="flex justify-center py-1">
        <AssistantMark size={88} busy={busy} />
      </div>
      <div data-testid="assistant-status" className="text-center text-[13px] text-muted-foreground">
        {statusLabel(host, input)}
      </div>
      {host.question === null ? null : <div className="text-[13px] text-muted-foreground">{host.question}</div>}
      {host.answer === '' ? null : (
        <div data-testid="assistant-answer" className="whitespace-pre-wrap">
          {host.answer}
        </div>
      )}
      {host.outcome === 'sent' ? <div data-testid="assistant-sent" className="text-[13px] text-[var(--color-accent)]">{S.assistant.sent}</div> : null}
      {host.outcome === 'cancelled' ? <div className="text-[13px] text-muted-foreground">{S.assistant.cancelled}</div> : null}
      {proposal === null ? null : (
        <div data-testid="assistant-card" className="flex flex-col gap-2 rounded-md bg-white/5 p-2.5">
          <div className="flex min-w-0 items-center gap-2 text-[13px] text-muted-foreground">
            <AssistantMark size={12} />
            <span className="min-w-0 truncate">
              {S.assistant.to} <span className="font-semibold text-foreground">{proposal.target}</span> · {proposal.where}
            </span>
          </div>
          <div className="whitespace-pre-wrap border-l-2 border-[var(--color-accent)] pl-2">{proposal.text}</div>
          {props.cardError === null ? null : <div className="text-[13px] text-[var(--status-warning-text)]">{props.cardError}</div>}
          <div className="flex items-center gap-2">
            <Button data-testid="assistant-send" size="default" className="cursor-pointer text-sm" disabled={!armed} onClick={() => props.onDecide('send')}>
              {S.assistant.send}
            </Button>
            <Button data-testid="assistant-cancel" size="default" variant="outline" className="cursor-pointer text-sm" onClick={() => props.onDecide('cancel')}>
              {S.assistant.cancel}
            </Button>
            <span className="ml-auto text-[12px] text-muted-foreground">{S.assistant.enterToSend}</span>
          </div>
        </div>
      )}
      {props.notice === null ? null : <div className="text-[13px] text-muted-foreground">{props.notice}</div>}
      <form
        className="flex items-center gap-2 rounded-md bg-white/5 px-2 py-1"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <input
          data-testid="assistant-input"
          autoFocus
          value={draft}
          placeholder={S.assistant.placeholder}
          className="min-w-0 flex-1 bg-transparent py-1 outline-none placeholder:text-muted-foreground"
          onChange={(event) => props.onDraft(event.target.value)}
        />
        <button type="button" data-testid="assistant-mic" aria-label={input === 'listening' ? S.assistant.stopMic : S.assistant.mic} className="cursor-pointer text-muted-foreground hover:text-foreground" onClick={props.onMic}>
          {input === 'listening' ? <MicOff size={16} className="text-[var(--color-accent)]" /> : <Mic size={16} />}
        </button>
      </form>
      <div className="flex justify-between text-[12px] text-muted-foreground">
        <span>{S.assistant.escToClose}</span>
        <span>{S.assistant.hotkeyToTalk(hotkeyLabel(props.hotkey))}</span>
      </div>
    </div>
  );
}
