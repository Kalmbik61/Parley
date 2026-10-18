/**
 * Итог комнаты (спека расхода токенов, 5): по каждому участнику — расход за его окна в комнате, затем сумма без двойного
 * счёта — целиком и по провайдерам. Цифры даёт `UsageResolver`: хост — индекс логов и срез, тесты — свои данные.
 */

import { isCurrentMember, roomMembership } from './room-membership.js';
import { roomLead } from './rooms.js';
import type { WorkMap, WorkSession } from './types.js';
import { sumUsage, type KeyedUsage, type UsageSummary, type UsageTotal, type UsageWindow } from './usage-ledger.js';

/** Источник цифр итога комнаты (5.2). */
export interface UsageResolver {
  /** Итог сессии целиком — тот же, что в `LiveMetrics.usage`; `null` — посчитать нечем. */
  whole(session: WorkSession): UsageSummary | null;
  /** Время первой и последней записи лога; `null` — лога нет (тогда берутся времена из карты). */
  bounds(session: WorkSession): { startedAt: string | null; endedAt: string | null } | null;
  /** Итог по логу за окна, с потомками; `null` — лога нет. */
  slice(session: WorkSession, windows: readonly UsageWindow[]): Promise<UsageSummary | null>;
}

export interface RoomUsageMember {
  sessionId: string;
  /** `null` — сессии уже нет в карте. */
  provider: string | null;
  lead: boolean;
  /** Окна участия, уже обрезанные архивом. */
  periods: UsageWindow[];
  /** Участник сейчас в комнате. */
  current: boolean;
  status: 'counted' | 'not-started' | 'unavailable';
  reason: 'log-missing' | 'deleted' | null;
  method: 'whole-session' | 'sliced' | null;
  /** Публичная часть итога (P36): без `binding`, `epoch`, нативных id и путей. */
  usage: UsageSummary | null;
  /** Старые карты: другие комнаты, где сессия числилась в то же время (5.5). */
  sharedWith: string[];
}

export interface RoomUsage {
  roomId: string;
  computedAt: string;
  /** Комната без журнала участия: история восстановлена (4.3). */
  reconstructed: boolean;
  total: UsageTotal;
  byProvider: Array<{ provider: string; total: UsageTotal }>;
  members: RoomUsageMember[];
}

const ms = (iso: string): number => Date.parse(iso);
const end = (to: string | null): number => (to === null ? Number.POSITIVE_INFINITY : ms(to));

/** Окна, обрезанные архивом: после `archivedAt` расход в комнату не идёт (5.1). */
function cutByArchive(periods: readonly UsageWindow[], archivedAt: string | null): UsageWindow[] {
  if (archivedAt === null) return [...periods];
  const limit = ms(archivedAt);
  return periods
    .filter((period) => ms(period.from) <= limit)
    .map((period) => ({ from: period.from, to: end(period.to) > limit ? archivedAt : period.to }));
}

const overlaps = (a: readonly UsageWindow[], b: readonly UsageWindow[]): boolean =>
  a.some((x) => b.some((y) => ms(x.from) < end(y.to) && ms(y.from) < end(x.to)));

/** Вся активность сессии внутри окна: начало не раньше входа, конец не позже ухода (или окно открыто). */
function wholeInside(bounds: { startedAt: string | null; endedAt: string | null }, period: UsageWindow): boolean {
  if (bounds.startedAt === null || ms(bounds.startedAt) < ms(period.from)) return false;
  if (period.to === null) return true;
  return bounds.endedAt !== null && ms(bounds.endedAt) <= ms(period.to);
}

/** Ключ разговора для `sumUsage`: семейство логов и id у провайдера (эпоха не входит). */
const conversationKey = (session: WorkSession): string =>
  `${session.provider === 'codex' ? 'codex' : 'claude'}\u0000${session.providerSessionId ?? session.id}`;

/** Итог группы: никого не посчитали и никто не пропал — ноль; кто-то пропал — итог не полнее нижней границы. */
function settle(total: UsageTotal, missing: boolean): UsageTotal {
  if (total.conversations === 0 && !missing) {
    return { ...total, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalInput: 0, completeness: 'complete' };
  }
  return missing && total.completeness === 'complete' ? { ...total, completeness: 'partial' } : total;
}

export async function roomUsage(map: WorkMap, roomId: string, resolver: UsageResolver, now: string): Promise<RoomUsage> {
  const room = map.rooms.find((candidate) => candidate.id === roomId);
  if (room === undefined) throw new Error(`room ${roomId} is not in the map`);
  const view = roomMembership(map, roomId);
  const others = map.rooms
    .filter((other) => other.id !== roomId)
    .map((other) => ({ id: other.id, members: roomMembership(map, other.id).members }));
  const lead = roomLead(room);
  const sessions = new Map(map.sessions.map((session) => [session.id, session]));

  const members: RoomUsageMember[] = [];
  for (const { session: sessionId, periods: raw } of view.members) {
    const periods = cutByArchive(raw, room.archivedAt ?? null);
    if (periods.length === 0) continue;
    const base = {
      sessionId,
      lead: sessionId === lead,
      periods,
      current: isCurrentMember(room, sessionId),
      sharedWith: others
        .filter((other) => other.members.some((member) => member.session === sessionId && overlaps(member.periods, raw)))
        .map((other) => other.id),
    };
    const session = sessions.get(sessionId);
    if (session === undefined) {
      members.push({ ...base, provider: null, status: 'unavailable', reason: 'deleted', method: null, usage: null });
      continue;
    }
    if (session.providerSessionId === null) {
      members.push({ ...base, provider: session.provider, status: 'not-started', reason: null, method: null, usage: null });
      continue;
    }
    const bounds = resolver.bounds(session) ?? { startedAt: session.startedAt, endedAt: session.endedAt };
    const whole = periods.length === 1 && wholeInside(bounds, periods[0] as UsageWindow);
    const usage = whole ? resolver.whole(session) : await resolver.slice(session, periods);
    members.push(
      usage === null
        ? { ...base, provider: session.provider, status: 'unavailable', reason: 'log-missing', method: null, usage: null }
        : { ...base, provider: session.provider, status: 'counted', reason: null, method: whole ? 'whole-session' : 'sliced', usage },
    );
  }

  // Порядок строк (3.2): ведущий, текущие участники по составу, вышедшие — по времени ухода.
  const order = room.members;
  const rank = (member: RoomUsageMember): number => (member.lead ? 0 : member.current ? 1 : 2);
  const lastExit = (member: RoomUsageMember): number => end(member.periods[member.periods.length - 1]?.to ?? null);
  members.sort(
    (a, b) =>
      rank(a) - rank(b) || (rank(a) === 1 ? order.indexOf(a.sessionId) - order.indexOf(b.sessionId) : lastExit(a) - lastExit(b)),
  );

  const totalOf = (group: readonly RoomUsageMember[]): UsageTotal => {
    const keyed: KeyedUsage[] = group.flatMap((member) => {
      const session = sessions.get(member.sessionId);
      return member.status === 'counted' && member.usage !== null && session !== undefined
        ? [{ key: conversationKey(session), usage: member.usage }]
        : [];
    });
    return settle(sumUsage(keyed), group.some((member) => member.status === 'unavailable'));
  };
  const providers = [...new Set(members.flatMap((member) => (member.provider === null ? [] : [member.provider])))];
  return {
    roomId,
    computedAt: now,
    reconstructed: view.reconstructed,
    total: totalOf(members),
    byProvider: providers.map((provider) => ({ provider, total: totalOf(members.filter((member) => member.provider === provider)) })),
    members,
  };
}
