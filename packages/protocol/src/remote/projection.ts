// Проекция снимка works.list для телефона (спека мобильного приложения §5.5, итог S7 §7.3).
// Тип хоста — только `import type`: код входа исполняется в Hermes и браузере, значений из корня протокола здесь нет.
import { z } from 'zod';
import type { WorksSnapshot } from '../types.js';

const isoOrNull = z.string().nullable();

/** Чего сессия ждёт от человека (`SessionNeed` хоста). */
const remoteStuckSchema = z.strictObject({
  kind: z.enum(['approval', 'question', 'limit', 'sign-in', 'startup']),
  since: z.string(),
  detail: z.string().nullable(),
  resetsAt: z.string().nullable(),
  window: z.enum(['session', 'week']).nullable(),
  account: z.enum(['auth', 'account']).nullable(),
});

export const remoteSessionSchema = z.strictObject({
  id: z.string(),
  label: z.string(),
  provider: z.string(),
  model: z.string().nullable(),
  /** Только `role.name`. */
  role: z.string().nullable(),
  parent: z.string().nullable(),
  /** Сессия, завёдшая эту через `create_session`; нет поля у хоста — `null`. */
  createdBy: z.string().nullable(),
  lifecycle: z.enum(['pending', 'active', 'sleeping', 'closed']),
  result: z.enum(['done', 'failed']).nullable(),
  stuck: remoteStuckSchema.nullable(),
  /** Последняя запись `history`; пустая история — `null`. */
  lastEvent: z.strictObject({ event: z.string(), at: z.string() }).nullable(),
  startedAt: isoOrNull,
  resultAt: isoOrNull,
});

/**
 * Решение комнаты — та же форма, что `Proposal` хоста. `plan` (`RoomPlan`) — вложенная структура плана, которую телефону
 * нужно только донести целиком: схема принимает её как `z.unknown()`, чтобы любой план хоста проходил проверку.
 */
export const remoteProposalSchema = z.strictObject({
  kind: z.enum(['decision', 'completion']).optional(),
  plan: z.unknown().optional(),
  planId: z.string().optional(),
  planRev: z.number().optional(),
  id: z.string(),
  from: z.string(),
  text: z.string(),
  rev: z.number(),
  at: z.string(),
});

const counters = z.strictObject({ total: z.number(), unread: z.number() });

export const remoteRoomSchema = z.strictObject({
  id: z.string(),
  title: z.string(),
  members: z.array(z.string()),
  lead: z.string().nullable(),
  /** Владелец комнаты; нет поля у хоста — `null`. */
  ownerId: z.string().nullable(),
  mode: z.enum(['free', 'checklist', 'verified', 'autonomous']).nullable(),
  /** `archivedAt != null`. */
  archived: z.boolean(),
  proposal: remoteProposalSchema.nullable(),
  messages: counters.nullable(),
});

/** Кто завёл рой (`SwarmCreator` хоста). */
const remoteSwarmCreatorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('session'), sessionId: z.string() }),
  z.strictObject({ kind: z.literal('room'), roomId: z.string() }),
  z.strictObject({ kind: z.literal('human') }),
]);

/** Рой без `objective`, `result`, `failure`, `seenAt`, `expiredAt` и `addedAt` участников. */
export const remoteSwarmSchema = z.strictObject({
  id: z.string(),
  tag: z.string(),
  creator: remoteSwarmCreatorSchema,
  queen: z.string(),
  members: z.array(
    z.strictObject({
      sessionId: z.string(),
      role: z.enum(['queen', 'drone', 'verifier']),
      n: z.number(),
      handedAt: z.string().nullable(),
    }),
  ),
  status: z.enum(['running', 'collecting', 'done', 'failed', 'cancelled']),
  createdAt: z.string(),
  endedAt: z.string().nullable(),
});

export const remoteWorkSchema = z.strictObject({
  projectPath: z.string(),
  id: z.string(),
  title: z.string(),
  status: z.enum(['active', 'done', 'archived']),
  messages: z.strictObject({ direct: counters.nullable(), inline: z.number() }),
  sessions: z.array(remoteSessionSchema),
  rooms: z.array(remoteRoomSchema),
  swarms: z.array(remoteSwarmSchema),
});

export const remoteWorksSnapshotSchema = z.strictObject({
  revision: z.number(),
  works: z.array(remoteWorkSchema),
});

export type RemoteSession = z.infer<typeof remoteSessionSchema>;
export type RemoteRoom = z.infer<typeof remoteRoomSchema>;
export type RemoteWork = z.infer<typeof remoteWorkSchema>;
export type RemoteWorksSnapshot = z.infer<typeof remoteWorksSnapshotSchema>;

type Entry = WorksSnapshot['entries'][number];
type Compact = Entry['map']['compact'];

/**
 * Счётчики канала (`''` — прямые письма). Версия 2 даёт `total` и `unread` в `rooms[id]`; у версии 1 `unread` берётся из
 * `compact.unread` (прямые — `letters`, комнаты — `rooms[id]`, нет записи — 0). Нет `compact` или канала — `null`.
 */
function channelCounters(compact: Compact, id: string): { total: number; unread: number } | null {
  if (!compact) return null;
  if (compact.version === 2) {
    const c = compact.rooms[id];
    return c ? { total: c.total, unread: c.unread } : null;
  }
  const c = compact.messages.rooms[id];
  if (!c) return null;
  return { total: c.total, unread: id === '' ? compact.unread.letters : (compact.unread.rooms[id] ?? 0) };
}

/** Проекция снимка хоста для телефона: порядок работ — порядок `entries`, без `task`, `summary`, `history`, метрик и планов. */
export function projectWorksSnapshot(snapshot: WorksSnapshot): RemoteWorksSnapshot {
  return {
    revision: snapshot.revision ?? 0,
    works: snapshot.entries.map((e) => {
      const m = e.map;
      return {
        projectPath: e.projectPath,
        id: m.work.id,
        title: m.work.title,
        status: m.work.status,
        messages: { direct: channelCounters(m.compact, ''), inline: Array.isArray(m.messages) ? m.messages.length : 0 },
        sessions: m.sessions.map((s) => {
          const le = s.history.length ? s.history[s.history.length - 1] : undefined;
          return {
            id: s.id,
            label: s.label,
            provider: s.provider,
            model: s.model ?? null,
            role: s.role?.name ?? null,
            parent: s.parent ?? null,
            createdBy: s.createdBy ?? null,
            lifecycle: s.lifecycle,
            result: s.result ?? null,
            stuck: s.stuck ?? null,
            lastEvent: le ? { event: le.event, at: le.at } : null,
            startedAt: s.startedAt ?? null,
            resultAt: s.resultAt ?? null,
          };
        }),
        swarms: (m.swarms ?? []).map((w) => ({
          id: w.id,
          tag: w.tag,
          creator: w.creator,
          queen: w.queen,
          members: w.members.map((x) => ({ sessionId: x.sessionId, role: x.role, n: x.n, handedAt: x.handedAt })),
          status: w.status,
          createdAt: w.createdAt,
          endedAt: w.endedAt,
        })),
        rooms: m.rooms.map((r) => ({
          id: r.id,
          title: r.title,
          members: r.members,
          lead: r.lead ?? null,
          ownerId: r.ownerId ?? null,
          mode: r.mode ?? null,
          archived: r.archivedAt != null,
          proposal: r.proposal ?? null,
          messages: channelCounters(m.compact, r.id),
        })),
      };
    }),
  };
}
