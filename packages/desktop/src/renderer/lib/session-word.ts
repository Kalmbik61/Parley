/**
 * Слово состояния сессии рядом со значком: одно выражение для строки сайдбара (`sidebar/SessionRow.tsx`) и карточки
 * доски (`board/target-info.ts`), чтобы слова на них не расходились.
 *
 * Порядок выбора:
 * - сессии нужен человек (`need`) — слово причины (`approval`, `limit · 19:27`, `starting`…; `needLabel`);
 * - запуск ждёт слота машины (`queued`) — слово очереди с причиной и числами (`queued · limit 18/18`). Запись очереди
 *   решает только у `pending` и `sleeping`, как в `agentStatus`, и слово очереди стоит там, где `agentStatus` называет
 *   сессию `queued`: сессия с итогом остаётся со словом итога;
 * - сессию усыпил хост (`autoSleep`) — слово причины сна (`asleep · idle`), тоже только там, где `agentStatus`
 *   называет её `asleep`. Остановленная человеком (`autoSleep` нет) осталась со словом состояния;
 * - иначе — слово состояния точки (`stateWord`): у живой сессии его ведёт activity, у остальных — статус карты.
 *
 * `need` у спящей, ожидающей запуска и закрытой всегда `null` (`sessionNeed`), но первым в выборе слова остаётся он.
 */

import type { SessionActivity, WorkSession } from '@parley/core';
import { agentStatus, autoSleepWord, queuedWord, sessionDotStateWithNeed, stateWord } from '@parley/core/session-state';
import { needLabel, sessionNeed } from '../attention/derive.js';

export function sessionWord(session: WorkSession, live: SessionActivity | null, now: Date): string {
  const need = sessionNeed(session, live);
  const state = sessionDotStateWithNeed(session, live?.activity ?? null, need);
  const hostSleep = need === null && session.lifecycle === 'sleeping' ? (session.autoSleep ?? null) : null;
  const queued = session.lifecycle === 'pending' || session.lifecycle === 'sleeping' ? (session.queued ?? null) : null;
  return need !== null
    ? needLabel(need, now.getTime())
    : queued !== null && agentStatus(session) === 'queued'
      ? queuedWord(queued)
      : hostSleep !== null && agentStatus(session) === 'asleep'
        ? autoSleepWord(hostSleep.reason)
        : stateWord(state, session.lifecycle);
}
