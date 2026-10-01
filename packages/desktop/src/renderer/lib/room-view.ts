/**
 * Помощники комнаты в окне: строка комнаты в сайдбаре (кусок 5 плана «Organic», спека окна 2026-09-29, 1.2, 2.6) — участники-сессии
 * по записи, время последнего события, ключ состояния окна и правило развёртывания по вкладкам раскладки. Ленту вкладки комнаты
 * строит `components/rooms/feed-model.ts` (прежний `roomView` — лента поверх `mail-view.ts`, кусок 3.6, — удалён вместе с
 * `RoomView`); ведущий — `room-lead.ts`, внимание — `attention/derive.ts`.
 */

import type { Room, WorkMap, WorkSession } from '@parley/core';
import type { WorkLayout } from '../../shared/layout-types.js';
import { groups } from '../layout/tree.js';
import { isoMs } from './iso-time.js';

// Тот же литерал, что и `HUMAN` в `core/work/types.ts` — импортировать можно
// только тип (см. комментарий в `mail-view.ts`/`participant-tag.ts`).
const HUMAN = 'human';

/**
 * Участники-сессии комнаты по записи: создатель-сессия, затем `members` в порядке записи (как лента участников
 * вкладки, `components/rooms/feed-model.ts`). Человек, повторы и сессии, которых уже нет в карте (удалены), не входят;
 * закрытые входят — значок-счётчик свёрнутой комнаты считает всех агентов, не только запущенных (решение 7).
 */
export function roomSessions(map: WorkMap, room: Room): WorkSession[] {
  const ids = [...new Set([room.creator, ...room.members])].filter((id) => id !== HUMAN);
  return ids.flatMap((id) => map.sessions.find((session) => session.id === id) ?? []);
}

/** Более позднее из двух времён; не-ISO время ничего не обгоняет (та же оговорка, что у `attention/derive.ts`). */
function later(a: string, b: string): string {
  const tb = isoMs(b);
  if (tb === null) return a;
  const ta = isoMs(a);
  return ta === null || tb > ta ? b : a;
}

/**
 * Время последнего события комнаты — справа в её строке: позднее из сообщений комнаты и решения (оно лежит
 * в слоте `Room.proposal`, письмом не становится, но для человека это событие). В пустой комнате — время её
 * создания. У комнаты карты до 2026-09-29 поля `proposal` нет.
 */
export function roomLastAt(map: WorkMap, room: Room): string {
  let last = room.createdAt;
  for (const message of map.messages) {
    if (message.roomId === room.id) last = later(last, message.at);
  }
  const proposal = room.proposal ?? null;
  return proposal === null ? last : later(last, proposal.at);
}

/**
 * Ключ комнаты в состоянии окна — `{workKey}/{roomId}`: `workKey` берёт проект и работу, потому что id комнат (`r-01`)
 * повторяются от работы к работе. Один ключ на `roomExpanded` и на черновики поля ввода комнаты (`composerDrafts`, спека 3.4).
 */
export function roomKey(workKey: string, roomId: string): string {
  return `${workKey}/${roomId}`;
}

/**
 * Что вкладки раскладки говорят о строке комнаты (правило развёртывания, спека 2.6). `selected` — активная
 * вкладка активной группы и есть вкладка этой комнаты: строка выбрана. `open` — вкладка комнаты или
 * терминал (дифф) одного из её участников — активная вкладка какой-нибудь группы, то есть видна на экране;
 * комната развёрнута по умолчанию. «Открыта» прочитано как «показана»: вкладки, что лежат в группе фоном,
 * держались бы неделями, и почти любая комната была бы развёрнута всегда. Раскладки ещё нет (работа не
 * гидрирована) — `null`.
 */
export function roomTabState(
  layout: WorkLayout | undefined,
  roomId: string,
  sessionIds: readonly string[],
): 'selected' | 'open' | null {
  if (layout === undefined) return null;
  let state: 'selected' | 'open' | null = null;
  for (const group of groups(layout)) {
    const tab = group.tabs.find((candidate) => candidate.id === group.activeTabId);
    if (tab === undefined) continue;
    if (tab.kind === 'room' && tab.roomId === roomId) {
      if (group.id === layout.activeGroupId) return 'selected';
      state = 'open';
    } else if ((tab.kind === 'terminal' || tab.kind === 'diff') && sessionIds.includes(tab.sessionId)) {
      state = 'open';
    }
  }
  return state;
}
