/**
 * Единое место, где состояние сессии превращается в то, что видят и называют все: точка и слово в окне, помощник
 * на хосте, бриф и инструменты MCP агентов. Раньше этот вывод жил в трёх местах и расходился: помощник считал
 * запущенную сессию выключенной. Теперь окно, помощник и бриф импортируют его отсюда.
 *
 * Модуль чистый: ни Node-импортов, ни значений из других файлов core (типы объявлены здесь; единственный
 * импорт — типа `NeedKind` из `stuck.ts`, он стирается при сборке). Поэтому его берёт и окно через подпуть
 * `@parley/core/session-state`, как `@parley/core/assistant`. В protocol его положить нельзя: protocol сам
 * зависит от core.
 *
 * Статус из двух осей выводится двумя способами, и оба нужны намеренно:
 * - `reportedStatus` — итог важнее процесса. Сессия, сдавшая `done`, показывается готовой, жив её процесс или нет.
 *   Так статус называют агенту бриф и MCP.
 * - `liveStatus` — у живой сессии итог не показываем: агент сдаёт `report` в конце каждого хода и остаётся жить,
 *   так что состояние ведёт activity. Итог видят только спящая и закрытая сессии. Так рисуют точку окно и помощник.
 *
 * Слова состояния (`STATE_WORDS`) английские и лежат здесь, а не в строках окна: по решению человека у окна,
 * помощника и агентов одна таблица. `S.states` окна её импортирует. Так же устроены слова `need` — чего сессия
 * ждёт от человека (`NEED_WORDS`, спека подписок 7): обрамление фразы («Waiting for approval: …») остаётся в
 * строках окна и слов видов не хранит.
 */

import type { NeedKind, SessionNeed } from './stuck.js';

/**
 * Прежний единый статус сессии (карта v1). В карте его больше нет: с v2 он собирается из двух осей функциями
 * `reportedStatus` и `liveStatus` — его называют агенту бриф и инструменты MCP, а точки окна рисуют его же.
 */
export type SessionStatus = 'pending' | 'active' | 'exited' | 'done' | 'failed';

/**
 * Ось процесса (спецификация 7.1): `sleeping` — процесса нет, но сессия на связи
 * и письмо её поднимает; `closed` — закрыта явно и писем не получает.
 */
export type SessionLifecycle = 'pending' | 'active' | 'sleeping' | 'closed';

/**
 * Ось итога: приходит только из `report` и процесс не меняет — после
 * `report(done)` сессия остаётся `active` (спецификация 7.1).
 */
export type SessionResult = 'done' | 'failed';

/** Чем занят живой агент: работает, ждёт человека, закончил ход незамеченным или стоит у приглашения. */
export type Activity = 'working' | 'blocked' | 'unseen' | 'idle';

/** Что рисует точка: activity живой сессии или её жизненный цикл (дизайн TUI v2, 4.1). */
export type DotState = Activity | Exclude<SessionStatus, 'active'>;

/** Ключи таблицы слов: `exited` расщеплён на `asleep` и `closed` по жизненному циклу. */
export type StateWordKey = Activity | 'pending' | 'asleep' | 'closed' | 'done' | 'failed';

/** Обе оси сессии. Структурный тип: подходит `WorkSession`, но не тянет карту. */
export interface SessionAxes {
  lifecycle: SessionLifecycle;
  result?: SessionResult | null;
}

/**
 * Статус для брифа и MCP. Итог важнее процесса: сессия, сдавшая `done`, показывается готовой,
 * жив её процесс или нет (спецификация 7.1).
 */
export function reportedStatus(session: SessionAxes): SessionStatus {
  switch (session.lifecycle) {
    case 'pending':
      return 'pending';
    case 'active':
      return session.result ?? 'active';
    case 'sleeping':
    case 'closed':
      return session.result ?? 'exited';
  }
}

/**
 * Статус для точки и слова. У живой сессии итог не показываем: агент сдаёт `report` в конце каждого хода
 * и остаётся жить, так что состояние ведёт activity. Итог видят спящая и закрытая сессии.
 */
export function liveStatus(session: SessionAxes): SessionStatus {
  switch (session.lifecycle) {
    case 'pending':
      return 'pending';
    case 'active':
      return 'active';
    case 'sleeping':
    case 'closed':
      return session.result ?? 'exited';
  }
}

/** Состояние точки: у живой сессии его ведёт activity, у остальных — статус карты. */
export function dotState(status: SessionStatus, activity: Activity | null): DotState {
  if (status !== 'active') return status;
  // Живая сессия без выведенной activity — тусклая: так же, как после
  // перезапуска харнесса (раздел 4.1).
  return activity ?? 'idle';
}

/** Состояние точки прямо из сессии: `dotState(liveStatus(session), activity)`. */
export function sessionDotState(session: SessionAxes, activity: Activity | null): DotState {
  return dotState(liveStatus(session), activity);
}

/**
 * Состояние точки с учётом `need` (спека подписок 7, итоговое ревью): сессия, которой нужен человек, — `blocked`,
 * даже когда ход закончен и activity говорит `unseen` или `idle` (лимит и вход оставляют ход законченным). «Живая» —
 * как у `sessionNeed`: `lifecycle === 'active'`; у спящей, ожидающей и закрытой `need` не считается (запись активности
 * могла остаться от прошлого процесса), и точка — по статусу карты.
 */
export function sessionDotStateWithNeed(
  session: SessionAxes,
  activity: Activity | null,
  need: SessionNeed | null,
): DotState {
  if (need !== null && session.lifecycle === 'active') return 'blocked';
  return sessionDotState(session, activity);
}

/**
 * Девять слов состояния сессии (спека окна 4.2). Строчными — так их пишет строка сессии; те же слова —
 * имена значков для скринридера и слово итога в тултипе, а помощник и агенты называют ими состояния сессий.
 */
export const STATE_WORDS: Readonly<Record<StateWordKey, string>> = {
  working: 'working',
  blocked: 'needs you',
  unseen: 'done · unseen',
  idle: 'idle',
  pending: 'not started',
  asleep: 'asleep',
  closed: 'closed',
  done: 'done',
  failed: 'failed',
};

/**
 * Слово состояния рядом со значком. У `exited` слово решает `lifecycle`: `closed` для закрытой сессии,
 * иначе `asleep` (сессия жива, просто не выведена).
 */
export function stateWord(state: DotState, lifecycle: SessionLifecycle): string {
  if (state === 'exited') return lifecycle === 'closed' ? STATE_WORDS.closed : STATE_WORDS.asleep;
  return STATE_WORDS[state];
}

/**
 * Слово на каждый вид `need` (спека подписок 7): одно у окна, острова, Telegram и брифа. `startup` называется
 * `starting` — «ждёт на старте», а не существительное. Порядок ключей — порядок `NeedKind`.
 */
export const NEED_WORDS: Readonly<Record<NeedKind, string>> = {
  approval: 'approval',
  question: 'question',
  limit: 'limit',
  'sign-in': 'sign-in',
  startup: 'starting',
};

/** Слово вида `need` из таблицы `NEED_WORDS`. */
export function needWord(kind: NeedKind): string {
  return NEED_WORDS[kind];
}
