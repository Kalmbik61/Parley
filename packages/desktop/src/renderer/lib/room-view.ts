/**
 * Лента одной комнаты (кусок 3.6 плана окна, спека 5.1, 6.3): та же лента,
 * что и «вся почта работы» (`lib/mail-view.ts`), только по письмам одной
 * комнаты, с постоянным составом участников (`Room.creator` + `Room.members`,
 * человек — всегда, `Вы`, спецификация 6.1) и заголовком — названием комнаты,
 * а не счётом писем.
 *
 * Построена поверх `mail-view.ts`: `toLetterView`/`recipientsOf`/
 * `isUnreadFor`/`DECISIONS_SHOWN` оттуда же — разбор письма в адресатов и
 * отметку «непрочитано» (`▤`, тест 3 куска) незачем повторять, разница только
 * в фильтре письма по `roomId`.
 */

import type { Room, WorkEntry, WorkMap, WorkSession } from '@harnas/core';
import type { WorkLayout } from '../../shared/layout-types.js';
import { groups } from '../layout/tree.js';
import { isoMs } from './iso-time.js';
import { participantTag } from './participant-tag.js';
import { DECISIONS_SHOWN, toLetterView, type LetterView } from './mail-view.js';

// Тот же литерал, что и `HUMAN` в `core/work/types.ts` — импортировать можно
// только тип (см. комментарий в `mail-view.ts`/`participant-tag.ts`).
const HUMAN = 'human';

export interface RoomView {
  title: string;
  /** `S01 (Opus 5.5) · S03 (Codex) · Вы` — создатель и участники, человек всегда последним (спека 6.3). */
  participants: string[];
  /** Id сессий-участников (создатель + `members`, без человека) — для поля ввода и приглашения новых. */
  memberIds: string[];
  decisions: { shown: LetterView[]; earlier: number };
  letters: LetterView[];
}

/** `null` — комнаты с таким id в карте нет (например, работа уже другая). */
export function roomView(
  entry: WorkEntry,
  roomId: string,
  providers: Array<{ id: string; label: string }>,
  models: Record<string, string | null>,
): RoomView | null {
  const map: WorkMap = entry.map;
  const room = map.rooms.find((candidate: Room) => candidate.id === roomId);
  if (room === undefined) return null;

  const tag = (id: string): string => participantTag(map, id, models[id] ?? null, providers);

  const messages = map.messages
    .filter((message) => message.roomId === roomId)
    .sort((a, b) => a.at.localeCompare(b.at));
  const letters = messages.map((message) => toLetterView(message, map, tag));

  const memberIds = [...new Set([room.creator, ...room.members])].filter((id) => id !== HUMAN);
  // Человек — участник всегда и в `members` не пишется (спека 6.1) — в шапке
  // он всё равно виден, последним, как в примере спеки 6.3.
  const participants = [...memberIds.map(tag), tag(HUMAN)];

  const decisionLetters = letters.filter((letter) => letter.kind === 'decision');
  const shown = decisionLetters.slice(-DECISIONS_SHOWN);
  const earlier = Math.max(0, decisionLetters.length - DECISIONS_SHOWN);

  return { title: room.title, participants, memberIds, decisions: { shown, earlier }, letters };
}

// ---------------------------------------------------------------------------
// Строка комнаты в сайдбаре (кусок 5 плана «Organic», спека окна 2026-09-29, 1.2, 2.6). Правил здесь —
// столько, сколько нужно и строке комнаты, и (позже) вкладке; ведущий — `room-lead.ts`, внимание — `attention/derive.ts`.
// ---------------------------------------------------------------------------

/**
 * Участники-сессии комнаты по записи: создатель-сессия, затем `members` в порядке записи (как лента участников
 * вкладки, `RoomView.memberIds`). Человек, повторы и сессии, которых уже нет в карте (удалены), не входят;
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

/** Ключ комнаты в состоянии окна (`roomExpanded`): работа и комната, как у черновиков комнаты (спека 3.4). */
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
