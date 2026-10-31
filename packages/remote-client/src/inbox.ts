// Inbox: что ждёт человека на хосте (спека §11.2 п. 2, D1 §7). Только по полям проекции и кэшу активности.
import type { FeedCard, Message } from '@parley/core';
import { cardGist, type CardGist } from '@parley/core/card-gist';
import { isHumanUnread, needsYouCount, sessionAttention, type Attention, type NeedsYouWork } from '@parley/core/attention';
import type { RemoteRoom, RemoteSession, RemoteWork } from '@parley/protocol/remote';
import { sessionKey, workKeyOf, type RemoteState, type SessionRef } from './state.js';

/** Чего ждёт сессия: `need` активности или, пока её нет, `stuck` проекции. */
export type RemoteNeed = NonNullable<RemoteSession['stuck']>;

export type InboxItem =
  | {
      kind: 'card';
      key: string;
      at: string;
      ref: SessionRef;
      sessionLabel: string;
      workTitle: string;
      card: FeedCard;
      gist: CardGist;
    }
  | {
      /** Сессия в `needs-you`, а карточки нет: Codex без события, лимит, вход, либо карточка ещё не прочитана. */
      kind: 'need';
      key: string;
      at: string;
      ref: SessionRef;
      sessionLabel: string;
      workTitle: string;
      need: RemoteNeed | null;
      /** Карточки этой сессии прочитаны и ждущих нет. */
      cardsLoaded: boolean;
      /** Последнее чтение карточек не удалось. */
      loadError: boolean;
    }
  | {
      kind: 'decision';
      key: string;
      at: string;
      projectPath: string;
      workId: string;
      roomId: string;
      roomTitle: string;
      workTitle: string;
      proposalId: string;
      rev: number;
      text: string;
    }
  | {
      kind: 'letter';
      key: string;
      at: string;
      projectPath: string;
      workId: string;
      workTitle: string;
      message: Message;
    };

/** Внимание по таблице спеки 7.1 для сессии проекции; из сессии нужен один `lifecycle`. */
export function attentionOfSession(state: RemoteState, ref: SessionRef, session: RemoteSession): Attention {
  const live = state.activity[sessionKey(ref)]?.activity ?? null;
  return sessionAttention(session, live);
}

const needOf = (state: RemoteState, key: string, session: RemoteSession): RemoteNeed | null => {
  const live = state.activity[key]?.activity.need;
  return live != null ? { ...live } : session.stuck;
};

const ms = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
};

export interface WaitingSession {
  ref: SessionRef;
  key: string;
  work: RemoteWork;
  session: RemoteSession;
}

/** Живые сессии в `needs-you`, в порядке снимка. */
export function needsYouSessions(state: RemoteState): WaitingSession[] {
  const out: WaitingSession[] = [];
  for (const work of state.snapshot?.works ?? []) {
    for (const session of work.sessions) {
      const ref = { projectPath: work.projectPath, workId: work.id, sessionId: session.id };
      if (attentionOfSession(state, ref, session) === 'needs-you') out.push({ ref, key: sessionKey(ref), work, session });
    }
  }
  return out;
}

const roomAwaits = (room: RemoteRoom): boolean => !room.archived && room.proposal !== null;

/** Все пункты Inbox, новые сверху (при равенстве времени — по ключу). */
export function selectInbox(state: RemoteState): InboxItem[] {
  const items: InboxItem[] = [];
  for (const { ref, key, work, session } of needsYouSessions(state)) {
    const entry = state.cards[key];
    const cards = entry?.cards ?? [];
    if (cards.length === 0) {
      const need = needOf(state, key, session);
      items.push({
        kind: 'need',
        key: `need:${key}`,
        at: need?.since ?? session.lastEvent?.at ?? '',
        ref,
        sessionLabel: session.label,
        workTitle: work.title,
        need,
        cardsLoaded: entry !== undefined && !entry.error,
        loadError: entry?.error === true,
      });
      continue;
    }
    for (const card of cards) {
      items.push({
        kind: 'card',
        key: `card:${key}\u0000${card.cardId}`,
        at: card.at,
        ref,
        sessionLabel: session.label,
        workTitle: work.title,
        card,
        gist: cardGist(card, work.projectPath),
      });
    }
  }
  for (const work of state.snapshot?.works ?? []) {
    for (const room of work.rooms) {
      const p = room.proposal;
      if (p === null || !roomAwaits(room)) continue;
      items.push({
        kind: 'decision',
        key: `room:${workKeyOf(work.projectPath, work.id)}\u0000${room.id}\u0000${p.id}\u0000${p.rev}`,
        at: p.at,
        projectPath: work.projectPath,
        workId: work.id,
        roomId: room.id,
        roomTitle: room.title,
        workTitle: work.title,
        proposalId: p.id,
        rev: p.rev,
        text: p.text,
      });
    }
    const letters = state.letters[workKeyOf(work.projectPath, work.id)] ?? {};
    for (const message of Object.values(letters)) {
      if (message.roomId !== null || !isHumanUnread(message)) continue;
      items.push({
        kind: 'letter',
        key: `letter:${workKeyOf(work.projectPath, work.id)}\u0000${message.id}`,
        at: message.at,
        projectPath: work.projectPath,
        workId: work.id,
        workTitle: work.title,
        message,
      });
    }
  }
  return items.sort((a, b) => {
    const d = ms(b.at) - ms(a.at);
    if (d !== 0 && !Number.isNaN(d)) return d;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

/**
 * Бейдж «нужен ты» (спека §9.2): та же функция `needsYouCount`, что считает число в push на мосте, поэтому бейдж вкладки
 * равен числу в уведомлении. Входы — проекция и кэш активности; письма — число из последнего снимка или `rooms.mail`.
 */
export function selectNeedsYouCount(state: RemoteState): number {
  const works: NeedsYouWork[] = (state.snapshot?.works ?? []).map((w) => ({
    projectPath: w.projectPath,
    workId: w.id,
    sessions: w.sessions,
    rooms: w.rooms,
    unreadLetters: state.letterUnread[workKeyOf(w.projectPath, w.id)] ?? 0,
  }));
  return needsYouCount(works, (projectPath, workId, sessionId) => state.activity[sessionKey({ projectPath, workId, sessionId })]?.activity ?? null);
}
