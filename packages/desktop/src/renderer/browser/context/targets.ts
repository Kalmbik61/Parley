/**
 * Цели «To» вкладки браузера (спека браузера 4.5): сессии и комнаты работы, умолчание и откат. Цель хранится в
 * раскладке (`TabSpec.target`); нет поля — умолчание: сессия в фокусе работы, иначе первая живая сессия, иначе первая
 * открытая комната. Архивная комната (PR #40) не цель: в ней нет поля ввода (`RoomPanel`), вложение осело бы в
 * черновике, которого никто не видит. Сохранённая цель пропала (сессию закрыли или удалили, комнату удалили или
 * архивировали) — снова умолчание, и вкладка сообщает об этом тостом (`use-page-context.ts`).
 */

import type { Room, WindowWorkEntry, WorkSession } from '@parley/core';
import type { BrowserTarget } from '../../../shared/layout-types.js';
import { sessionRowLabel, sessionTag } from '../../lib/participant.js';
import { isRoomArchived } from '../../lib/room-archive.js';

export interface TargetOption {
  target: BrowserTarget;
  /** `session:s-02` или `room:r-01`: ключ пункта меню и пачки тоста. */
  key: string;
  /** Имя в кнопке «To» и в тосте: `S02` или название комнаты. */
  name: string;
  /** Строка меню: `S02 backend` или название комнаты. */
  title: string;
  provider: string | null;
  /** Как ляжет вложение: чипом в Chat или строкой в ввод CLI; `null` — неизвестно (или комната). */
  mode: 'chat' | 'terminal' | null;
}

export function targetKey(target: BrowserTarget): string {
  return target.kind === 'session' ? `session:${target.sessionId}` : `room:${target.roomId}`;
}

/** Сессии меню: закрытая вложение не примет. */
function listedSessions(entry: WindowWorkEntry): WorkSession[] {
  return entry.map.sessions.filter((session) => session.lifecycle !== 'closed');
}

/** Комнаты меню: архивная читается, но писать в неё нельзя — поля ввода нет. */
function listedRooms(entry: WindowWorkEntry): Room[] {
  return entry.map.rooms.filter((room) => !isRoomArchived(room));
}

export function targetOptions(
  entry: WindowWorkEntry,
  chatAvailable: (provider: string) => boolean | null,
): { sessions: TargetOption[]; rooms: TargetOption[] } {
  const sessions = listedSessions(entry).map((session): TargetOption => {
    const available = chatAvailable(session.provider);
    return {
      target: { kind: 'session', sessionId: session.id },
      key: `session:${session.id}`,
      name: sessionTag(session.id),
      title: sessionRowLabel(session.id, session.label),
      provider: session.provider,
      mode: available === null ? null : available ? 'chat' : 'terminal',
    };
  });
  const rooms = listedRooms(entry).map(
    (room): TargetOption => ({ target: { kind: 'room', roomId: room.id }, key: `room:${room.id}`, name: room.title, title: room.title, provider: null, mode: null }),
  );
  return { sessions, rooms };
}

export function isTargetAlive(entry: WindowWorkEntry, target: BrowserTarget): boolean {
  return target.kind === 'session'
    ? listedSessions(entry).some((session) => session.id === target.sessionId)
    : listedRooms(entry).some((room) => room.id === target.roomId);
}

export function defaultTarget(entry: WindowWorkEntry, focusedSessionId: string | null): BrowserTarget | null {
  const sessions = listedSessions(entry);
  if (focusedSessionId !== null && sessions.some((session) => session.id === focusedSessionId)) {
    return { kind: 'session', sessionId: focusedSessionId };
  }
  const live = sessions.find((session) => session.lifecycle === 'active');
  if (live !== undefined) return { kind: 'session', sessionId: live.id };
  const room = listedRooms(entry)[0];
  return room === undefined ? null : { kind: 'room', roomId: room.id };
}

export function resolveTarget(
  entry: WindowWorkEntry,
  stored: BrowserTarget | undefined,
  focusedSessionId: string | null,
): { target: BrowserTarget | null; fellBack: boolean } {
  if (stored !== undefined && isTargetAlive(entry, stored)) return { target: stored, fellBack: false };
  return { target: defaultTarget(entry, focusedSessionId), fellBack: stored !== undefined };
}

export function targetName(entry: WindowWorkEntry, target: BrowserTarget): string {
  if (target.kind === 'session') return sessionTag(target.sessionId);
  return entry.map.rooms.find((room) => room.id === target.roomId)?.title ?? target.roomId;
}
