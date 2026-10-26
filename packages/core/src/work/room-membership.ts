/**
 * Окна участия сессий в комнате (спека расхода токенов, 4.3, 5.1): по журналу `Room.memberLog`, а у комнаты, созданной
 * до журнала, — восстановленные по ленте и составу. Обрезки архивом здесь нет: её делает подсчёт (`roomUsage`).
 */

import { mapLetterTx, type LetterReads } from './letter-store.js';
import { joinedLine } from './rooms.js';
import { HUMAN, SYSTEM, type Room, type WorkMap } from './types.js';
import type { UsageWindow } from './usage-ledger.js';

export interface MemberPeriods {
  session: string;
  /** По времени входа, без перекрытий; `to: null` — ещё в комнате. */
  periods: UsageWindow[];
}

export interface RoomMembershipView {
  /** По времени первого входа. */
  members: MemberPeriods[];
  /** Комната без журнала: история восстановлена и может быть неполной. */
  reconstructed: boolean;
}

interface Entry {
  room: string;
  at: string;
}

const ms = (iso: string): number => Date.parse(iso);
const end = (to: string | null): number => (to === null ? Number.POSITIVE_INFINITY : ms(to));

/** Текущий рабочий участник из сессий: запись в `members`. */
export const isCurrentMember = (room: Room, sessionId: string): boolean =>
  sessionId !== HUMAN && room.members.includes(sessionId);

/** Входы в старую комнату: строки «joined» её ленты, а у текущих участников без строки — создание комнаты. */
function legacyEntries(map: WorkMap, room: Room, letters: LetterReads): Array<{ session: string; at: string }> {
  const lines = new Map<string, string[]>();
  // Системные строки комнаты — запросом, ограниченным их числом (спека хранилища 6.2).
  const system = { roomId: room.id, from: SYSTEM };
  for (const message of letters.query({ ...system, limit: letters.count(system) })) {
    lines.set(message.text, [...(lines.get(message.text) ?? []), message.at]);
  }
  const candidates = new Set([...map.sessions.map((session) => session.id), ...room.members]);
  candidates.delete(HUMAN);
  const entries: Array<{ session: string; at: string }> = [];
  for (const session of candidates) {
    const times = lines.get(joinedLine(session)) ?? [];
    for (const at of times) entries.push({ session, at });
    if (times.length === 0 && isCurrentMember(room, session)) entries.push({ session, at: room.createdAt });
  }
  return entries;
}

/** Все входы каждой сессии во все комнаты работы, по времени. */
function entriesBySession(map: WorkMap, letters: LetterReads): Map<string, Entry[]> {
  const result = new Map<string, Entry[]>();
  for (const room of map.rooms) {
    const entries =
      room.memberLog !== undefined
        ? room.memberLog.map((record) => ({ session: record.session, at: record.from }))
        : legacyEntries(map, room, letters);
    for (const { session, at } of entries) result.set(session, [...(result.get(session) ?? []), { room: room.id, at }]);
  }
  for (const list of result.values()) list.sort((a, b) => ms(a.at) - ms(b.at));
  return result;
}

/** Окна одной сессии по порядку, перекрытия склеены. */
function merge(periods: readonly UsageWindow[]): UsageWindow[] {
  const merged: UsageWindow[] = [];
  for (const period of [...periods].sort((a, b) => ms(a.from) - ms(b.from))) {
    const last = merged[merged.length - 1];
    if (last !== undefined && ms(period.from) <= end(last.to)) {
      if (end(period.to) > end(last.to)) last.to = period.to;
    } else merged.push({ ...period });
  }
  return merged;
}

function group(periods: ReadonlyArray<{ session: string } & UsageWindow>): MemberPeriods[] {
  const bySession = new Map<string, UsageWindow[]>();
  for (const { session, from, to } of periods) bySession.set(session, [...(bySession.get(session) ?? []), { from, to }]);
  return [...bySession]
    .map(([session, list]) => ({ session, periods: merge(list) }))
    .sort((a, b) => ms(a.periods[0]!.from) - ms(b.periods[0]!.from));
}

/**
 * Окна участия в комнате. По журналу — как записаны. Без журнала: каждый вход длится до ближайшего входа той же сессии
 * в другую комнату (одна комната на сессию); последний вход текущего участника открыт — в старых картах сессия
 * числилась в нескольких комнатах разом. Ушедшего начального участника и ушедшего создателя восстановить не по чему.
 */
export function roomMembership(
  map: WorkMap,
  roomId: string,
  letters: LetterReads = mapLetterTx(map).letters,
): RoomMembershipView {
  const room = map.rooms.find((candidate) => candidate.id === roomId);
  if (room === undefined) throw new Error(`room ${roomId} is not in the map`);
  if (room.memberLog !== undefined) {
    return { reconstructed: false, members: group(room.memberLog.map(({ session, from, to }) => ({ session, from, to }))) };
  }
  const periods: Array<{ session: string } & UsageWindow> = [];
  for (const [session, entries] of entriesBySession(map, letters)) {
    const here = entries.filter((entry) => entry.room === roomId);
    here.forEach((entry, index) => {
      const open = index === here.length - 1 && isCurrentMember(room, session);
      const exit = open ? undefined : entries.find((next) => next.room !== roomId && ms(next.at) > ms(entry.at));
      periods.push({ session, from: entry.at, to: exit?.at ?? null });
    });
  }
  return { reconstructed: true, members: group(periods) };
}
