/**
 * Служебные сообщения хоста в разговор острова (спека автономии §6.3): событие слежения за сессией (§6.2) и итог
 * автономного действия, что не достался создавшему запуску (§5.3), становятся служебным Request разговора `island` с job
 * происхождения `system`. Этот модуль — реализация `onWatchEvent` и `deliverOutcome` сервиса помощника; `host.ts` его
 * только подключает.
 *
 * Что лежит в служебном Request: `text` (и `requestText` job) — одна строка для человека; `context` — закреплённые
 * данные: у события слежения `{ service: 'watch', event, key, ref, name, snapshot }` (снимок — `ReplySnapshot`, при
 * замене прежнего события той же сессии ещё `earlierReplies`), у итога действия `{ service: 'outcome', cardId, kind,
 * outcome }`. Готовый текст на случай, если пересказ не начат за срок, — в `ServiceTag.fallback` job.
 */

import type { SessionRef } from '@parley/protocol';
import { stepLinesOf, type AssistantService, type WatchDelivery } from './assistant-service.js';
import type { CardRow } from './cards.js';
import type { Jobs, ServiceDrop, ServiceTag } from './jobs.js';
import { SERVICE_VOICE_SESSION, type Requests, type RequestView } from './requests.js';
import type { ActionOutcome } from './run-plan.js';

/** Разговор острова: служебные сообщения идут только туда. */
export const SERVICE_CONVERSATION = 'island';

export interface ServiceMessagesDeps {
  requests: Pick<Requests, 'submitService' | 'dropService'>;
  jobs: Pick<Jobs, 'cancelQueuedService'>;
  /** Переход итога карточки `pending → sent_as_message`; зовётся внутри транзакции создания Request. */
  takeResult(proposalId: string): boolean;
  /** Флаг автономного режима, синхронно: читается в том же участке, что создаёт Request о событии слежения. */
  autonomous(): boolean;
  /** Строка для человека (`AssistantState.watchNote`): сообщение о событии снято переполнением очереди. */
  note(text: string): void;
}

export interface ServiceMessages {
  /** Событие слежения → служебный Request; режим выключен — `null`, ничего не создано. Повтор события — тот же Request. */
  watchEvent(event: WatchDelivery): RequestView | null;
  /**
   * Итог автономного действия → служебный Request с ключом — id карточки, одной транзакцией с переходом `result_state`
   * в `sent_as_message`. Итог уже взят запуском или уже отправлен — `null`, ничего не создано. Флаг режима не читается.
   */
  outcome(card: CardRow, outcome: ActionOutcome): RequestView | null;
  /** Режим выключен: ждущие сообщения о событиях слежения отменяются без доставки. Возвращает, сколько отменено. */
  autonomyOff(): number;
  /** Очередь сняла служебные job при возврате после `limit` (`jobs` `onServiceDrop`): Request неактуальны, заметка о снятых переполнением. */
  dropped(drops: ServiceDrop[]): void;
}

/** Группа замены: одна сессия (номер сессии уникален внутри работы, а не хоста). */
const groupOf = (ref: SessionRef): string => JSON.stringify([ref.projectPath, ref.workId, ref.sessionId]);

/** Ключ события слежения: `watch:<проект>:<работа>:<сессия>:<ключ события>`. */
export const watchKeyOf = (event: Pick<WatchDelivery, 'ref' | 'key'>): string => `watch:${event.ref.projectPath}:${event.ref.workId}:${event.ref.sessionId}:${event.key}`;

/** Ключ итога действия: id карточки. */
export const outcomeKeyOf = (proposalId: string): string => `outcome:${proposalId}`;

const sentence = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}${/[.!?]$/.test(text) ? '' : '.'}`;

/**
 * Готовый текст итога действия для человека (job закрыт без пересказа): что сделано, что неизвестно, можно ли повторять —
 * словами, по именам из карточки, без её id и без указаний модели.
 */
export function outcomeSpeech(card: CardRow, outcome: ActionOutcome): string {
  const what = stepLinesOf(card).join('; ');
  const done = outcome.effects.join('; ');
  const reason = outcome.reason === null ? null : sentence(outcome.reason);
  const parts: Array<string | null> =
    outcome.status === 'done'
      ? [`Done: ${done === '' ? what : done}.`, outcome.reason === null ? null : `Note: ${outcome.reason}${/[.!?]$/.test(outcome.reason) ? '' : '.'}`]
      : outcome.status === 'partial'
        ? [`Only part of it was done: ${done}.`, reason]
        : outcome.status === 'not_done'
          ? [`Not done: ${what}.`, reason]
          : [`Not sure whether this went through: ${what}.`, done === '' ? null : `Done for sure: ${done}.`, reason];
  if (outcome.status !== 'done') {
    parts.push(
      outcome.retry === 'safe'
        ? 'Nothing was changed, so it is safe to try again.'
        : outcome.status === 'partial'
          ? 'Check what is missing before trying again, so nothing happens twice.'
          : 'Check before trying again: it may already have happened.',
    );
  }
  return parts.filter((part) => part !== null).join(' ');
}

export function createServiceMessages(deps: ServiceMessagesDeps): ServiceMessages {
  /** Заметка человеку о сообщениях, снятых переполнением очереди. */
  const noteOverflow = (dropped: readonly RequestView[]): void => {
    for (const request of dropped) {
      const name = typeof request.context?.['name'] === 'string' ? request.context['name'] : 'a session';
      deps.note(`Skipped the reply from ${name}: too many messages were waiting`);
    }
  };
  return {
    watchEvent(event) {
      // Флаг и создание — один синхронный участок: событие после выключения Request не создаёт.
      if (!deps.autonomous()) return null;
      const waiting = event.event === 'needs-human' ? (event.need?.kind ?? 'input') : null;
      const service: ServiceTag = {
        kind: 'watch',
        group: groupOf(event.ref),
        fallback: waiting === null ? `${event.name} replied; the summary is not ready.` : `${event.name} is waiting for you (${waiting}); the summary is not ready.`,
      };
      const done = deps.requests.submitService({
        conversationId: SERVICE_CONVERSATION,
        voiceSessionId: SERVICE_VOICE_SESSION,
        delegationId: watchKeyOf(event),
        text: waiting === null ? `Reply from ${event.name}` : `${event.name} is waiting: ${waiting}`,
        context: { service: 'watch', event: event.event, key: event.key, ref: event.ref, name: event.name, snapshot: event.snapshot },
        origin: 'system',
        service,
      });
      noteOverflow(done?.overflow ?? []);
      return done?.request ?? null;
    },
    outcome(card, outcome) {
      const text = outcomeSpeech(card, outcome);
      const done = deps.requests.submitService(
        {
          conversationId: SERVICE_CONVERSATION,
          voiceSessionId: SERVICE_VOICE_SESSION,
          delegationId: outcomeKeyOf(card.proposalId),
          text: `Outcome of action ${card.proposalId}`,
          context: { service: 'outcome', cardId: card.proposalId, kind: card.kind, outcome },
          origin: 'system',
          service: { kind: 'outcome', group: null, fallback: text },
        },
        () => deps.takeResult(card.proposalId),
      );
      return done?.request ?? null;
    },
    autonomyOff() {
      return deps.jobs.cancelQueuedService('watch').length;
    },
    dropped(drops) {
      noteOverflow(deps.requests.dropService(drops));
    },
  };
}

/**
 * Старт хоста (спека автономии §6.2): сначала применяется начальное значение флага и при выключенном режиме снимаются
 * ждущие события слежения, оставшиеся с прошлого запуска; только потом очередь job восстанавливается и разбирается
 * (`recover`), затем невыданные итоги действий уходят служебными сообщениями. Флаг не прочитан — режим считается выключенным.
 */
export async function startServiceQueue(deps: {
  assistant: Pick<AssistantService, 'refreshAutonomy' | 'state' | 'deliverRestartOutcomes'>;
  messages: Pick<ServiceMessages, 'autonomyOff'>;
  jobs: Pick<Jobs, 'recover'>;
  log(line: string): void;
}): Promise<void> {
  try {
    await deps.assistant.refreshAutonomy();
  } catch (error) {
    deps.log(`assistant: autonomy flag was not read: ${(error as Error).message}`);
  }
  // `refreshAutonomy` зовёт `onAutonomyOff` только при смене значения; на старте снимаем явно.
  if (deps.assistant.state().autonomous !== true) deps.messages.autonomyOff();
  try {
    await deps.jobs.recover();
  } catch (error) {
    deps.log(`assistant jobs: recover failed: ${(error as Error).message}`);
  }
  deps.assistant.deliverRestartOutcomes();
}
