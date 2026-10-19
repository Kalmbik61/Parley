/**
 * Большой вид помощника на острове (спека 2026-10-14, 8.2; эталон — island-mockup.html): рой душ с ореолом, подпись
 * состояния с точкой, последний вопрос и ответ, карточка подтверждения, строка ввода.
 *
 * Окно острова — фиксированный кадр, поэтому вид не выше `maxHeight`: вопрос, ответ, карточка и подсказка живут в
 * прокручиваемой середине, а рой, подпись и строка ввода всегда на месте. Вопрос — не длиннее двух строк (целиком —
 * в подсказке), чтобы длинная фраза не оттесняла ответ за край.
 *
 * Отправленный вопрос виден сразу (`sending`), до хоста: прошлый ответ уходит выше, в приглушённую историю обменов, а
 * сообщения, что ждут конца хода, лежат внизу середины серыми «Queued» с ×.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Mic, X } from 'lucide-react';
import type { FeedDecision } from '@parley/core';
import type { AssistantProposal, AssistantState } from '@parley/protocol';
import { S } from '../../../shared/strings.js';
import { AssistantMark } from '../../components/AssistantMark.js';
import { Button } from '../../ui/button.js';
import { levelWidth } from '../../voice/level.js';
import { formatElapsed, useElapsed } from '../../voice/MicButton.js';
import { Swarm } from '../swarm/Swarm.js';
import { haloFor, swarmSpecFor } from '../swarm/spec.js';
import { hotkeyLabel, statusLabel } from './labels.js';
import { ASK_MAX, type Exchange, type InputPhase, type QueuedMessage } from './store.js';

export interface AssistantViewProps {
  host: AssistantState;
  input: InputPhase;
  /** Громкость микрофона (rms из стора, 0…≈0,2): рой сжимается и волнуется в такт. */
  level: number;
  /** Когда началась запись (для таймера `m:ss`); `null` — не записываем. */
  listenStartedAt: number | null;
  draft: string;
  notice: string | null;
  cardError: string | null;
  /** Вопрос ушёл, хост ещё не начал по нему ход: остров показывает его сам. */
  sending: string | null;
  queue: readonly QueuedMessage[];
  /** Прошлые обмены разговора — приглушённо над текущим вопросом. */
  history: readonly Exchange[];
  /** Решение карточки в пути: Send крутится, обе кнопки не жмутся. */
  deciding: 'send' | 'cancel' | null;
  hotkey: string;
  /** Ждущие запросы одобрения: первая сессия и сколько всего. */
  pending: { name: string; total: number } | null;
  /** Предел высоты вида (CSS-значение): кадр острова минус чёлка и ряд под видом. */
  maxHeight: string;
  onDraft(text: string): void;
  onSubmit(text: string): void;
  onMic(): void;
  onDecide(decision: 'send' | 'cancel'): void;
  onUnqueue(id: number): void;
  onShowRequests(): void;
}

/** Как `CARD_ARM_MS` острова: кнопки карточки взводятся не сразу — случайный клик у края экрана не отправит. */
const ARM_MS = 500;

/** Цвет точки у подписи состояния; остальные фазы — акцентный (класс), без inline-цвета. */
const STATUS_DOT: Partial<Record<AssistantState['phase'], string>> = { error: '#dc604c', offline: '#9c948a', 'awaiting-confirm': '#ffc24d' };

/** Подпись кнопки подтверждения: следует за видом карточки и решением в ней. */
function confirmLabel(proposal: AssistantProposal): string {
  switch (proposal.action) {
    case 'room':
      return S.assistant.card.create;
    case 'decision': {
      const { decision } = proposal;
      if (decision.kind === 'permission') return decision.behavior === 'deny' ? S.assistant.card.deny : decision.always === true ? S.assistant.card.allowAlways : S.assistant.card.allow;
      if (decision.kind === 'question') return S.assistant.card.answer;
      return decision.choice === 'manual' ? S.assistant.card.approveEachEdit : S.assistant.card.acceptPlan;
    }
    case 'room-decision':
      return proposal.choice === 'accept' ? S.assistant.card.accept : S.assistant.card.return;
    default:
      return proposal.wake ? S.assistant.wakeAndSend : S.assistant.send;
  }
}

/** Глагол заголовка карточки решения: что сделает подтверждение. */
function decisionVerb(decision: FeedDecision): string {
  if (decision.kind === 'permission') return decision.behavior === 'deny' ? S.assistant.card.deny : S.assistant.card.allow;
  if (decision.kind === 'question') return S.assistant.card.answer;
  return decision.choice === 'manual' ? S.assistant.card.approveEachEdit : S.assistant.card.acceptPlan;
}

/** Первые 1500 знаков текста предложения; обрезанное кончается многоточием. */
function clip(text: string): string {
  return text.length > 1500 ? `${text.slice(0, 1500)}…` : text;
}

/** Содержимое карточки до кнопок: письмо, новая комната, решение запроса агента или решение по предложению ведущего. */
function cardBody(proposal: AssistantProposal, mentions: readonly string[]): JSX.Element {
  switch (proposal.action) {
    case 'room': {
      return (
        <>
          <div className="flex min-w-0 items-center gap-2 text-[13px] text-muted-foreground">
            <AssistantMark size={12} />
            <span className="min-w-0 truncate">
              {S.assistant.card.newRoom} <span className="font-semibold text-foreground">{proposal.where}</span>
            </span>
          </div>
          <div data-testid="assistant-room-line" className="text-[13px] [overflow-wrap:anywhere]">
            {S.assistant.card.roomLine(proposal.title, proposal.members.join(', '), proposal.lead)}
          </div>
          {proposal.task === null ? null : <div className="whitespace-pre-wrap border-l-2 border-[var(--color-accent)] pl-2 [overflow-wrap:anywhere]">{proposal.task}</div>}
        </>
      );
    }
    case 'decision': {
      return (
        <>
          <div className="flex min-w-0 items-center gap-2 text-[13px] text-muted-foreground">
            <AssistantMark size={12} />
            <span data-testid="assistant-card-title" className="min-w-0 truncate font-semibold text-foreground">
              {proposal.decision.kind === 'plan' ? S.assistant.card.planTitle(decisionVerb(proposal.decision), proposal.target) : S.assistant.card.askTitle(decisionVerb(proposal.decision), proposal.target)}
            </span>
          </div>
          <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">{proposal.card.summary}</div>
          {proposal.card.detail === null ? null : (
            <pre data-testid="assistant-card-detail" className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-black/20 p-1.5 font-mono text-[12px]">
              {proposal.card.detail}
            </pre>
          )}
          {/* Выбранные ответы: человек подтверждает именно их; вопрос — первой строкой. */}
          {proposal.decision.kind === 'question'
            ? Object.entries(proposal.decision.answers).map(([question, answer]) => (
                <div key={question} data-testid="assistant-card-answer" className="whitespace-pre-wrap text-[13px] [overflow-wrap:anywhere]">
                  {S.assistant.card.answerLine(question.split('\n')[0] ?? '', answer)}
                </div>
              ))
            : null}
        </>
      );
    }
    case 'room-decision': {
      return (
        <>
          <div className="flex min-w-0 items-center gap-2 text-[13px] text-muted-foreground">
            <AssistantMark size={12} />
            <span data-testid="assistant-card-title" className="min-w-0 truncate font-semibold text-foreground">
              {proposal.choice === 'accept' ? S.assistant.card.acceptDecision(proposal.target) : S.assistant.card.returnDecision(proposal.proposal.from)}
            </span>
          </div>
          <div className="max-h-40 overflow-auto whitespace-pre-wrap border-l-2 border-[var(--color-accent)] pl-2 [overflow-wrap:anywhere]">{clip(proposal.proposal.text)}</div>
          {proposal.note === null ? null : <div className="text-[13px] text-muted-foreground">{S.assistant.card.note(proposal.note)}</div>}
        </>
      );
    }
    default: {
      return (
        <>
          <div className="flex min-w-0 items-center gap-2 text-[13px] text-muted-foreground">
            <AssistantMark size={12} />
            <span className="min-w-0 truncate">
              {S.assistant.to} <span className="font-semibold text-foreground">{proposal.target}</span> · {proposal.where}
            </span>
          </div>
          {proposal.wake ? (
            <div data-testid="assistant-wake-note" className="text-[12px] text-muted-foreground">
              {S.assistant.wakeNote}
            </div>
          ) : null}
          <div className="whitespace-pre-wrap border-l-2 border-[var(--color-accent)] pl-2 [overflow-wrap:anywhere]">
            {/* Упомянутые — чипами впереди текста, как их нарисует лента комнаты (письмо уйдёт с токенами `@s03`). */}
            {mentions.map((name) => (
              <span key={name} data-testid="assistant-mention" className="mr-1 inline-block rounded-full bg-[color-mix(in_srgb,var(--color-accent)_22%,transparent)] px-[7px] font-semibold">
                @{name}
              </span>
            ))}
            {proposal.text}
          </div>
        </>
      );
    }
  }
}

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
  const { host, input, draft, pending, sending, queue, deciding } = props;
  // Пока вопрос в пути, текущий обмен уже стоит в истории: хост его ещё не сменил, а остров — сменил.
  const history: readonly Exchange[] =
    sending !== null && host.question !== null ? [...props.history, { id: -1, question: host.question, answer: host.answer === '' ? (host.error ?? '') : host.answer }] : props.history;
  const proposal = host.proposal;
  const mentions = proposal !== null && (proposal.action === undefined || proposal.action === 'message') ? (proposal.mentions ?? []) : [];
  const armed = useArmed(proposal?.id ?? null);
  const elapsed = useElapsed(input === 'listening' ? props.listenStartedAt : null);
  // Пока вопрос в пути, рой думает: хост ещё в прошлой фазе.
  const swarmPhase = sending === null ? host.phase : 'thinking';
  const spec = useMemo(() => swarmSpecFor({ ...host, phase: swarmPhase }, input, false), [swarmPhase, input]);
  const halo = haloFor(spec, host);
  const dotColor = STATUS_DOT[host.phase];
  const scrollRef = useRef<HTMLDivElement>(null);
  const proposalId = proposal?.id ?? null;
  // Пока ждёт карточка или очередь или выше стоит история, середина держится у низа: ответ дописывается внизу, а Send,
  // ждущие сообщения и сам ответ не должны уехать из виду — Enter в пустом поле отправляет карточку, и человек должен
  // видеть, что именно.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if ((proposalId === null && queue.length === 0 && history.length === 0) || element === null) return;
    element.scrollTop = element.scrollHeight;
  }, [proposalId, queue.length, history.length, sending, host.turn, host.answer, props.cardError, props.notice]);
  const submit = (): void => {
    if (draft.trim() === '' && proposal !== null && armed && deciding === null) props.onDecide('send');
    else props.onSubmit(draft);
  };
  const question = sending ?? host.question;
  return (
    <div data-testid="assistant-view" className="island-reveal flex w-[420px] flex-col gap-2 px-3 pb-3 pt-1.5 text-sm" style={{ maxHeight: props.maxHeight }}>
      {pending === null ? null : (
        <button type="button" data-testid="assistant-pending" className="flex cursor-pointer items-center gap-2 self-start rounded px-1 text-[13px] text-foreground/80 hover:bg-white/10" onClick={props.onShowRequests}>
          <span className="size-[7px] rounded-full bg-[var(--color-accent)]" />
          {S.assistant.needsYou(pending.name, pending.total)}
        </button>
      )}
      <div className="relative -mx-3 h-[136px] shrink-0">
        <div
          aria-hidden
          className="absolute inset-0 transition-opacity duration-300"
          style={{ background: `radial-gradient(ellipse 46% 62% at 50% 42%, rgba(${halo.rgb}, ${halo.alpha}), transparent 72%)` }}
        />
        <Swarm spec={spec} souls={700} width={420} height={136} d={86} cy={62} k={0.058} minPx={2.4} fps={60} mic={levelWidth(props.level)} className="absolute inset-0" />
      </div>
      <div data-testid="assistant-status" className="flex items-center justify-center gap-1.5 text-[13px] text-muted-foreground">
        <span
          data-testid="assistant-status-dot"
          className={`size-[7px] shrink-0 rounded-full ${dotColor === undefined ? 'bg-[var(--color-accent)]' : ''} ${input === 'listening' ? 'assistant-dot-pulse' : ''}`}
          {...(dotColor === undefined ? {} : { style: { background: dotColor } })}
        />
        {statusLabel(host, input, sending !== null)}
      </div>
      {/* Середина сжимается первой (`min-h-0`); пустая не занимает места и не добавляет зазор. Нажатие на ней не тащит
          остров: иначе ползунок прокрутки двигал бы окно. */}
      <div ref={scrollRef} data-testid="assistant-scroll" data-no-drag className="flex min-h-0 flex-col gap-2 overflow-y-auto empty:hidden">
        {history.map((exchange) => (
          <div key={exchange.id} data-testid="assistant-history" className="flex shrink-0 flex-col gap-1 text-[13px] text-muted-foreground">
            <div title={exchange.question} className="line-clamp-2">
              {exchange.question}
            </div>
            {exchange.answer === '' ? null : <div className="whitespace-pre-wrap opacity-80">{exchange.answer}</div>}
          </div>
        ))}
        {question === null ? null : (
          <div data-testid="assistant-question" title={question} className="line-clamp-2 shrink-0 text-[13px] text-muted-foreground">
            {question}
          </div>
        )}
        {host.answer === '' || sending !== null ? null : (
          <div data-testid="assistant-answer" className="shrink-0 whitespace-pre-wrap">
            {host.answer}
          </div>
        )}
        {sending === null && host.outcome === 'sent' ? <div data-testid="assistant-sent" className="text-[13px] text-[var(--color-accent)]">{S.assistant.sent}</div> : null}
        {sending === null && host.outcome === 'cancelled' ? <div className="text-[13px] text-muted-foreground">{S.assistant.cancelled}</div> : null}
        {sending === null && host.outcome === 'done' ? <div data-testid="assistant-done" className="text-[13px] text-[var(--color-accent)]">{S.assistant.done}</div> : null}
        {/* Карточку закрыл хост с причиной (уже отвечена, решение пересмотрено, задача не ушла): карточки уже нет, причина — рядом с итогом. */}
        {sending === null && proposal === null && props.cardError !== null ? (
          <div data-testid="assistant-outcome-note" className="text-[13px] text-[var(--status-warning-text)]">
            {props.cardError}
          </div>
        ) : null}
        {proposal === null ? null : (
          <div data-testid="assistant-card" className="flex shrink-0 flex-col gap-2 rounded-md bg-white/5 p-2.5">
            {cardBody(proposal, mentions)}
            {props.cardError === null ? null : <div className="text-[13px] text-[var(--status-warning-text)]">{props.cardError}</div>}
            <div className="flex items-center gap-2">
              <Button data-testid="assistant-send" size="default" className="cursor-pointer text-sm" disabled={!armed || deciding !== null} aria-busy={deciding === 'send'} onClick={() => props.onDecide('send')}>
                {deciding === 'send' ? <Loader2 data-testid="assistant-send-spinner" size={14} className="animate-spin" /> : null}
                {confirmLabel(proposal)}
              </Button>
              <Button data-testid="assistant-cancel" size="default" variant="outline" className="cursor-pointer text-sm" disabled={deciding !== null} onClick={() => props.onDecide('cancel')}>
                {S.assistant.cancel}
              </Button>
              <span className="ml-auto text-[12px] text-muted-foreground">{S.assistant.enterToSend}</span>
            </div>
          </div>
        )}
        {queue.map((item) => (
          <div key={item.id} data-testid="assistant-queued" className="flex shrink-0 items-start gap-2 text-[13px] text-muted-foreground">
            <span className="line-clamp-2 min-w-0 flex-1" title={item.text}>
              {item.text}
            </span>
            <span className="shrink-0 text-[12px]">{S.assistant.queued}</span>
            <button
              type="button"
              aria-label={S.assistant.unqueue}
              className="shrink-0 cursor-pointer hover:text-foreground"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => props.onUnqueue(item.id)}
            >
              <X size={14} />
            </button>
          </div>
        ))}
        {props.notice === null ? null : <div className="text-[13px] text-muted-foreground">{props.notice}</div>}
      </div>
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
          maxLength={ASK_MAX}
          placeholder={S.assistant.placeholder}
          className="min-w-0 flex-1 bg-transparent py-1 outline-none placeholder:text-muted-foreground"
          onChange={(event) => props.onDraft(event.target.value)}
        />
        {input === 'listening' ? (
          <>
            <span className="h-1.5 w-10 overflow-hidden rounded-full bg-white/10">
              <span className="block h-full bg-destructive transition-[width]" style={{ width: `${Math.round(levelWidth(props.level) * 100)}%` }} />
            </span>
            <span data-testid="assistant-mic-elapsed" className="text-xs tabular-nums text-muted-foreground">
              {formatElapsed(elapsed)}
            </span>
          </>
        ) : null}
        <button
          type="button"
          data-testid="assistant-mic"
          aria-label={input === 'listening' ? S.assistant.stopMic : input === 'transcribing' ? S.assistant.transcribing : S.assistant.mic}
          disabled={input === 'transcribing'}
          className="cursor-pointer text-muted-foreground hover:text-foreground"
          onMouseDown={(event) => event.preventDefault()}
          onClick={props.onMic}
        >
          {input === 'listening' ? (
            <span className="assistant-dot-pulse block size-2.5 rounded-full bg-destructive" />
          ) : input === 'transcribing' ? (
            <Loader2 size={16} className="animate-spin" />
          ) : (
            <Mic size={16} />
          )}
        </button>
      </form>
      <div className="flex justify-between text-[12px] text-muted-foreground">
        <span>{S.assistant.escToClose}</span>
        <span>{S.assistant.hotkeyToTalk(hotkeyLabel(props.hotkey))}</span>
      </div>
    </div>
  );
}
