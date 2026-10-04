/**
 * Панель одной комнаты (спека окна 2026-09-29, 1.3, 2.2–2.4; кусок 6 плана): шапка с лентой участников,
 * лента сообщений с блоком `Decisions` первым, поле ввода с упоминаниями. Данные — `buildRoomModel`
 * (`feed-model.ts`), рисуют `RoomHeader`, `RoomMessage` и `Composer`.
 *
 * Над полем ввода — живая строка (Parley 0.2.0): по строке на участника, который чем-то занят, —
 * `S02 · Subagent: Orca research`, `S03 · Waiting for messages`. Это состояние, а не переписка: в ленту оно
 * не пишется, а когда никто ничем не занят, строки нет. Строки обрезаются, а блок выше 96px прокручивается:
 * много занятых участников не должны выдавить ленту из невысокого окна. Появление, смена и исчезновение строки
 * меняют высоту ленты: если до этого она стояла у низа (не дальше 48px от дна), её прижимают заново, а того, кто
 * читает историю выше, не дёргают. Положение запоминается по событию `scroll` ленты, а не мерится при отрисовке:
 * чтение раскладки в render было бы синхронной перекладкой на каждое событие активности.
 *
 * Карточка решения — последней в ленте, пока `Room.proposal` не `null`. Кнопки зовут
 * `rooms.resolveProposal` с `proposalId` и `rev` показанной карточки: человек не примет текст, которого не
 * видел. `conflict` — тост, карточка не ломается, живая версия приходит событием карты. Метода нет у
 * хоста — кнопок нет.
 *
 * Прочтение — существующий механизм писем человеку (`attention/use-mark-read.ts`): сообщение, чья
 * строка меты видна ≥1 с при активной работе, фокусе окна и видимом документе, уходит в `mail.markRead`
 * (пачка через 500 мс тишины); карта отвечает, точка гаснет. Прокрутка — при открытии к самому раннему
 * непрочитанному упоминанию человека (`@human`, `MessageModel.mentionsYou`), а без него к низу. Без перехода к
 * упоминанию его могло бы не оказаться на экране: человек жмёт `@N` на карточке работы, отметка «прочитано» не
 * наступает, и счётчик горит. Дальше лента сама не прыгает (Parley 0.3.0): новое сообщение или решение прижимает её
 * к низу, только если она стояла у низа или сообщение написал сам человек. Того, кто читает историю или оригинал
 * цитаты, она не уводит — пришедшее копится в кнопке `↓N` поверх низа ленты, как в «всей почте» (`MailPanel.tsx`);
 * клик по ней — к низу, а дочитав до низа сам, человек её гасит.
 *
 * Сообщение-ответ несёт цитату (`RoomMessage.tsx`): клик по ней прокручивает ленту к оригиналу (`jumpTo`),
 * переносит на него фокус (строка сообщения принимает его программно, `tabIndex={-1}`) и на 1.2 с подсвечивает —
 * атрибутом `data-reply-flash` (`styles/reply-flash.css`), повторный клик перезапускает отсчёт. Подсветка ставится
 * сразу, а плавная прокрутка до далёкого оригинала длится дольше неё: чтобы подсветка не угасла по дороге, лента один
 * раз ждёт `scrollend` на себе (не дольше 2 с — оригинал мог уже стоять на месте) и по нему перезапускает подсветку
 * того же сообщения. Новый переход и закрытие вкладки снимают и ожидание, и его страховочный таймер. К упоминанию при
 * открытии комнаты лента переходит так же (`showMessage`), но сразу, без плавности и без фокуса: человек ещё
 * ничего не нажимал в ленте, и ждать нечего. После перехода лента стоит не у низа (это запоминает `onFeedScroll` по
 * событию `scroll`), поэтому новое сообщение человека от оригинала не уводит.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { WorkEntry } from '@parley/core';
import type { ParleyBridge } from '../../../shared/bridge.js';
import { decodeIpcError } from '../../../shared/ipc-error.js';
import { S, errorText } from '../../../shared/strings.js';
import { useMarkRead } from '../../attention/use-mark-read.js';
import { useHostSupports } from '../../lib/capabilities.js';
import { sessionRowLabel, sessionTag } from '../../lib/participant.js';
import { relativeTime } from '../../lib/relative-time.js';
import { roomKey } from '../../lib/room-view.js';
import { workKey } from '../../lib/tree-order.js';
import { useNow } from '../../lib/use-now.js';
import type { ActivityEntry } from '../../store/activity.js';
import { Decisions } from '../mail/Decisions.js';
import { Composer, type ComposerSubmission } from './Composer.js';
import { useHostStore } from '../../store/host.js';
import { PlanPanel, RoomModeControl } from './PlanPanel.js';
import { CompletionCard } from './CompletionCard.js';
import { DecisionCard } from './DecisionCard.js';
import { buildRoomModel } from './feed-model.js';
import { RoomHeader } from './RoomHeader.js';
import { RoomMessage } from './RoomMessage.js';

export interface RoomPanelProps {
  entry: WorkEntry;
  roomId: string;
  providers: Array<{ id: string; label: string }>;
  /** Живая активность сессий (`useActivityStore.byRef`): состояния в ленте участников и в меню упоминаний. */
  activity: Record<string, ActivityEntry>;
  bridge: ParleyBridge;
  /** Работа активна (`LayoutBodyContext.active`): сообщения скрытой работы LRU не отмечаются прочитанными. */
  active: boolean;
  onOpenExternal: (url: string) => void;
  /** Клик по карточке участника: открыть терминал его сессии; по агенту в поповере строки субагентов — на карточке агента (`agentId`). */
  onOpenSession: (sessionId: string, agentId?: string) => void;
}

/** Относительное время сообщений («2m») обновляется раз в столько же, что и в сайдбаре. */
const NOW_PERIOD_MS = 30_000;

/** Лента «у низа», если до дна не больше стольких px: дочитавший почти до конца историю уже не читает. */
const AT_BOTTOM_PX = 48;

/** Сколько оригинал цитаты остаётся подсвеченным после клика по ней (`data-reply-flash`). */
const REPLY_FLASH_MS = 1200;

/** Дольше лента не ждёт `scrollend` после плавной прокрутки: оригинал мог уже стоять на месте — тогда события не будет. */
const SCROLL_END_WAIT_MS = 2000;

export function RoomPanel({ entry, roomId, providers, activity, bridge, active, onOpenExternal, onOpenSession }: RoomPanelProps): JSX.Element {
  const model = buildRoomModel({ entry, roomId, providers, activity });
  // Участники, которые чем-то заняты, — по строке над полем ввода. Ключ меняется, когда строка появилась,
  // исчезла или сменилась: от него зависит высота ленты.
  const busy = model?.participants.filter((participant) => participant.doing !== null) ?? [];
  const liveKey = busy
    .map((participant) => `${participant.id}\u0000${participant.doing}`)
    .join('\n');
  // Хуки — до раннего выхода «комнаты нет»: порядок хуков не должен зависеть от данных.
  const markRead = useMarkRead({ bridge, projectPath: entry.projectPath, workId: entry.map.work.id, active });
  const now = useNow(NOW_PERIOD_MS);
  const canResolve = useHostSupports('rooms.resolveProposal') && entry.map.work.status === 'active';
  const connection = useHostStore(state => state.connections);
  const status = useHostStore(state => state.status.state);
  const resolveKey = [entry.projectPath, entry.map.work.id, roomId, connection, status, entry.map.work.status, canResolve, model?.plan?.id, model?.plan?.rev, JSON.stringify(model?.proposal)].join('\0');
  const currentResolve = useRef(resolveKey); currentResolve.current = resolveKey;
  const currentBridge = useRef(bridge); currentBridge.current = bridge;
  const resolveMounted = useRef(true);
  useEffect(() => { resolveMounted.current = true; return () => { resolveMounted.current = false; }; }, []);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Стоит ли лента у низа — по последнему `scroll`: после коммита живая строка уже сожмёт ленту, и по DOM
  // «был ли у низа» не определить, а мерить его при каждой отрисовке — перекладка на каждое событие.
  const atBottomRef = useRef(true);
  // Сколько пришло снизу, пока человек читал историю: сообщения и решения, при которых лента стояла не у низа (`↓N`).
  const [below, setBelow] = useState(0);
  const onFeedScroll = useCallback((): void => {
    const feed = containerRef.current;
    if (feed === null) return;
    atBottomRef.current = feed.scrollHeight - feed.scrollTop - feed.clientHeight <= AT_BOTTOM_PX;
    // Дочитал до низа сам — пришедшее он уже видит.
    if (atBottomRef.current) setBelow(0);
  }, []);

  const pinToBottom = useCallback((): void => {
    const container = containerRef.current;
    if (container === null) return;
    container.scrollTop = container.scrollHeight;
    atBottomRef.current = true;
    setBelow(0);
  }, []);

  /** Высота ленты изменилась (живая строка, форма возврата у решения): у низа стояла — остаётся у низа, иначе не трогаем. */
  const keepAtBottom = useCallback((): void => {
    if (atBottomRef.current) pinToBottom();
  }, [pinToBottom]);

  // Подсвеченный оригинал цитаты и таймер, который снимет подсветку: она одна на ленту.
  const flashRef = useRef<{ element: HTMLElement; timer: ReturnType<typeof setTimeout> } | null>(
    null,
  );
  const clearFlash = useCallback((): void => {
    const flash = flashRef.current;
    if (flash === null) return;
    clearTimeout(flash.timer);
    flash.element.removeAttribute('data-reply-flash');
    flashRef.current = null;
  }, []);
  /** Подсветить сообщение на 1.2 с; уже подсвеченное (это же или другое) — заново: подсветка одна на ленту. */
  const flashMessage = useCallback(
    (element: HTMLElement): void => {
      // Снять и поставить заново: повторная подсветка перезапускает анимацию CSS (как `attention/flash.ts`).
      clearFlash();
      void element.offsetWidth;
      element.setAttribute('data-reply-flash', '');
      flashRef.current = { element, timer: setTimeout(clearFlash, REPLY_FLASH_MS) };
    },
    [clearFlash],
  );

  // Ожидание конца плавной прокрутки: слушатель `scrollend` ленты и страховочный таймер, который его снимает.
  // Как и подсветка, оно одно на ленту; ленту хранит запись сама — при закрытии вкладки `containerRef` уже пуст.
  const settleRef = useRef<{
    feed: HTMLElement;
    onEnd: () => void;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const clearSettle = useCallback((): void => {
    const settle = settleRef.current;
    if (settle === null) return;
    clearTimeout(settle.timer);
    settle.feed.removeEventListener('scrollend', settle.onEnd);
    settleRef.current = null;
  }, []);
  // Вкладку закрыли — таймеры подсветки и ожидания, как и слушатель `scrollend`, не должны её пережить.
  useEffect(
    () => () => {
      clearSettle();
      clearFlash();
    },
    [clearSettle, clearFlash],
  );

  /**
   * Лента прокручивается к сообщению по центру (выше ленты — к верху), и оно коротко подсвечивается; `false` — такого
   * сообщения в ленте нет.
   * `smooth` — плавная прокрутка (клик по цитате) или мгновенная (открытие комнаты); `focus` — перенести на сообщение
   * фокус. Подсветка ставится сразу; при плавной прокрутке она перезапускается ещё раз, когда лента доехала
   * (`scrollend`, не дольше `SCROLL_END_WAIT_MS`).
   */
  const showMessage = useCallback(
    (messageId: string, { smooth, focus }: { smooth: boolean; focus: boolean }): boolean => {
      const feed = containerRef.current;
      if (feed === null) return false;
      // Сравнение через dataset — без экранирования id в селекторе.
      const target = [...feed.querySelectorAll<HTMLElement>('[data-message-id]')].find(
        (element) => element.dataset.messageId === messageId,
      );
      if (target === undefined) return false;
      // Новый переход: прежнего конца прокрутки больше не ждём.
      clearSettle();
      // Сообщение выше ленты по центру ушло бы строкой меты за верхний край, а прочтение смотрит именно на неё
      // (`use-mark-read.ts`): такое сообщение встаёт к верху.
      const block = target.offsetHeight > feed.clientHeight ? 'start' : 'center';
      target.scrollIntoView({ block, behavior: smooth ? 'smooth' : 'auto' });
      // Фокус — на сообщение: читающий с клавиатуры продолжит с него. Без прокрутки — её уже запустила строка выше.
      if (focus) target.focus({ preventScroll: true });
      flashMessage(target);
      if (smooth) {
        const onEnd = (): void => {
          clearSettle();
          flashMessage(target);
        };
        settleRef.current = { feed, onEnd, timer: setTimeout(clearSettle, SCROLL_END_WAIT_MS) };
        feed.addEventListener('scrollend', onEnd);
      }
      return true;
    },
    [clearSettle, flashMessage],
  );

  /** Клик по цитате ответа: переход к оригиналу — плавный (без движения, если человек его отключил) и с фокусом. */
  const jumpTo = useCallback(
    (messageId: string): void => {
      const reduceMotion =
        typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
      showMessage(messageId, { smooth: !reduceMotion, focus: true });
    },
    [showMessage],
  );

  // Как лента расположена при открытии: к какому сообщению (`null` — к низу) и для какого её состояния. Повторный прогон
  // эффекта с тем же состоянием (StrictMode гоняет эффекты дважды и между прогонами снимает подсветку) повторяет это
  // расположение, а не прижимает ленту к низу.
  const openedRef = useRef<{ key: string; mentionId: string | null } | null>(null);
  // Что лента уже показала: id сообщений и решение (`id` и `rev`). По разнице с ним видно, что пришло нового.
  const seenRef = useRef<{ ids: ReadonlySet<string>; proposal: string } | null>(null);

  // Лента расположена при открытии: к самому раннему непрочитанному упоминанию человека, а если такого нет — к низу.
  // Дальше — новое сообщение, новое или переделанное решение (карточка — последняя в ленте). Ленту оно прижимает к
  // низу, только если она стояла у низа или сообщение написал сам человек: своё он ждёт увидеть. Того, кто читает
  // историю или оригинал цитаты, лента не уводит — пришедшее копится в `↓N`. Ленты нет, пока комнаты нет в карте:
  // открытие — первое её расположение.
  useLayoutEffect(() => {
    if (containerRef.current === null) return;
    const messages = model?.messages ?? [];
    const waiting = model?.proposal ?? null;
    const proposal = waiting === null ? '' : `${waiting.id}\u0000${waiting.rev}`;
    const key = `${messages.length}\u0000${proposal}`;
    const seen = seenRef.current;
    seenRef.current = { ids: new Set(messages.map((message) => message.id)), proposal };
    if (openedRef.current === null) {
      const mention = messages.find((message) => message.unread && message.mentionsYou);
      openedRef.current = { key, mentionId: mention?.id ?? null };
    }
    const { key: openedKey, mentionId } = openedRef.current;
    if (openedKey === key) {
      if (mentionId !== null && showMessage(mentionId, { smooth: false, focus: false })) {
        // Прокрутка мгновенная, а событие `scroll` придёт позже: стоит ли лента у низа, запоминаем сразу — иначе
        // эффект живой строки ниже счёл бы, что она у низа, и прижал её обратно.
        onFeedScroll();
        return;
      }
      pinToBottom();
      return;
    }
    const fresh = messages.filter((message) => seen?.ids.has(message.id) !== true);
    const added = fresh.length + (proposal !== '' && proposal !== seen?.proposal ? 1 : 0);
    const own = fresh.some((message) => message.sender.kind === 'human');
    if (atBottomRef.current || own) pinToBottom();
    else if (added > 0) setBelow((count) => count + added);
    // Зависимости — длина ленты и версия решения, а не сами `model.messages`: модель собирается заново на каждой
    // отрисовке (событие активности), а эффект нужен, только когда пришло новое.
  }, [
    pinToBottom,
    showMessage,
    onFeedScroll,
    model?.messages.length,
    model?.proposal?.id,
    model?.proposal?.rev,
  ]);

  // Живая строка сжала или расширила ленту: у низа стояла — остаётся у низа, читают историю — не трогаем.
  useLayoutEffect(keepAtBottom, [keepAtBottom, liveKey]);

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
  const draftKey = roomKey(workKey(entry.projectPath, entry.map.work.id), roomId);

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

  /** Ответ человека на решение. `true` — хост принял; `false` — отказ, причина уже показана тостом. */
  const handleResolve = async (action: 'accept' | 'return', note: string): Promise<boolean> => {
    const proposal = model.proposal;
    if (proposal === null || !canResolve) return false;
    const captured = resolveKey;
    try {
      await bridge.call('rooms.resolveProposal', {
        projectPath: entry.projectPath,
        workId: entry.map.work.id,
        roomId,
        proposalId: proposal.id,
        rev: proposal.rev,
        ...(proposal.planId !== undefined && proposal.planRev !== undefined ? {planId:proposal.planId, planRev:proposal.planRev} : {}),
        action,
        ...(action === 'return' ? { note } : {}),
      });
      return resolveMounted.current && captured === currentResolve.current && currentBridge.current === bridge;
    } catch (error) {
      if (!resolveMounted.current || captured !== currentResolve.current || currentBridge.current !== bridge) return false;
      const { code } = decodeIpcError(error);
      // `conflict`: карточку успели принять, вернуть или заменить — она остаётся, кнопки снова доступны.
      toast(code === 'conflict' ? S.rooms.decisionChanged : errorText(code, S.rooms.resolveAction));
      return false;
    }
  };

  return (
    <div data-room-panel="" className="flex h-full min-h-0 min-w-0 flex-col">
      <RoomHeader modeControl={<RoomModeControl key={draftKey} entry={entry} roomId={roomId} bridge={bridge}/>} title={model.title} subtitle={model.subtitle} participants={model.participants} onOpenSession={onOpenSession} />
      {/* Обёртка — только для кнопки `↓N` поверх низа ленты: прокручивается сама лента. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={containerRef}
          onScroll={onFeedScroll}
          data-room-feed=""
          className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-9 py-[18px]"
        >
          <PlanPanel key={draftKey} entry={entry} roomId={roomId} bridge={bridge}/>
          <Decisions
            decisions={model.decisions}
            labelOf={labelOf}
            onOpenExternal={onOpenExternal}
            className="max-w-[680px]"
          />
          {model.empty ? <p className="m-0 text-sm text-muted-foreground">{S.rooms.emptyFeed}</p> : null}
          {model.messages.map((message) => (
            <RoomMessage
              key={message.id}
              message={message}
              now={now}
              labelOf={labelOf}
              onOpenExternal={onOpenExternal}
              onJumpTo={jumpTo}
              observeRef={markRead(message.id, message.needsRead)}
            />
          ))}
          {model.proposal === null ? null : (
            <CompletionOrDecision
              plan={model.plan}
              entry={entry}
              bridge={bridge}
              key={model.proposal.id}
              proposal={model.proposal}
              time={relativeTime(model.proposal.at, now)}
              labelOf={labelOf}
              onOpenExternal={onOpenExternal}
              canResolve={canResolve}
              {...(entry.map.work.status !== 'active' ? {unavailableReason:S.plans.workClosed} : {})}
              onResolve={handleResolve}
              onLayout={keepAtBottom}
            />
          )}
        </div>
        {below > 0 ? (
          <button
            type="button"
            data-room-new-below=""
            onClick={pinToBottom}
            title={S.rooms.newBelow(below)}
            aria-label={S.rooms.newBelow(below)}
            className="absolute bottom-3 right-9 rounded-full bg-secondary px-2.5 py-1 text-xs text-foreground shadow-sm"
          >
            ↓{below}
          </button>
        ) : null}
      </div>
      {busy.length === 0 ? null : (
        <div
          data-room-live=""
          className="flex max-h-24 shrink-0 flex-col gap-0.5 overflow-y-auto px-9 pb-1.5 pt-1 text-xs text-muted-foreground"
        >
          {busy.map((participant) => (
            <div
              key={participant.id}
              title={participant.doingDetail ?? undefined}
              className="truncate"
            >
              {`${sessionTag(participant.id)} · ${participant.doing}`}
            </div>
          ))}
        </div>
      )}
      <Composer key={draftKey} members={members} draftKey={draftKey} onSend={handleSend} />
    </div>
  );
}

function CompletionOrDecision({ plan, entry, bridge, ...props }: import('./DecisionCard.js').DecisionCardProps & { plan: import('@parley/core').RoomPlan | null; entry: WorkEntry; bridge: ParleyBridge }): JSX.Element {
  return props.proposal.kind === 'completion' ? <CompletionCard {...props} plan={plan} entry={entry} bridge={bridge}/> : <DecisionCard {...props} entry={entry} bridge={bridge}/>;
}
