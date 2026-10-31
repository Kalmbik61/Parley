// Works: работы в порядке сайдбара и дерево внутри работы (D1 §8). Зеркало `cardRows` окна
// (`desktop/renderer/sidebar/sort.ts`): сессии под создателем (`createdBy`), комнаты под владельцем (`ownerId`),
// рои под создателем (`creator`); рои прячутся, как `isSwarmShown`. Из десктопа ничего не импортируется.
import { ATTENTION_RANK, type Attention } from '@parley/core/attention';
import { isSwarmTerminal } from '@parley/core/swarms';
import type { RemoteRoom, RemoteSession, RemoteWork } from '@parley/protocol/remote';
import { attentionOfSession } from './inbox.js';
import { workKeyOf, type ActivityEntry, type RemoteState } from './state.js';

export type RemoteSwarm = RemoteWork['swarms'][number];

export interface SwarmMemberView {
  member: RemoteSwarm['members'][number];
  /** `null` — сессию удалили из снимка. */
  session: RemoteSession | null;
}

export type WorkRow =
  | { kind: 'session'; session: RemoteSession; depth: number; parent: string | null; attention: Attention; live: ActivityEntry | null }
  | { kind: 'room'; room: RemoteRoom; depth: number; parent: string | null; members: RemoteSession[]; archived: boolean }
  | { kind: 'swarm'; swarm: RemoteSwarm; depth: number; parent: string | null; members: SwarmMemberView[] };

export interface WorkView {
  key: string;
  work: RemoteWork;
  level: Attention;
  /** Сессии в `needs-you` и комнаты с ждущим решением. */
  needsYou: number;
  lastEventAt: string;
  rows: WorkRow[];
  /** Архивные комнаты — под ссылкой «N archived rooms». */
  archivedRooms: RemoteRoom[];
}

export interface ProjectGroup {
  projectPath: string;
  name: string;
  works: WorkView[];
}

export interface WorksViewOptions {
  /** Закрытые сессии, завершённые рои и архивные работы. По умолчанию скрыты. */
  showClosed?: boolean;
}

const ms = (iso: string | null): number => {
  if (iso === null) return Number.NEGATIVE_INFINITY;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
};

/** Рой виден: идущий; законченный `done`/`failed`, пока человек не видел итог (`seenAt`); остальные — при `showClosed`. */
export function isSwarmShown(swarm: Pick<RemoteSwarm, 'status' | 'seenAt'>, showClosed: boolean): boolean {
  if (!isSwarmTerminal(swarm.status)) return true;
  if (showClosed) return true;
  return (swarm.status === 'done' || swarm.status === 'failed') && swarm.seenAt === null;
}

/** Имя папки — последний сегмент пути. */
export function folderName(projectPath: string): string {
  return projectPath.split('/').filter((p) => p !== '').at(-1) ?? projectPath;
}

const staysOnCard = (s: RemoteSession): boolean => s.lifecycle === 'active' || s.lifecycle === 'pending';

/** Сессии деревом по `parent`, в порядке снимка; сирота с неизвестным родителем — корень. */
function treeOrder(sessions: readonly RemoteSession[]): Array<{ session: RemoteSession; depth: number }> {
  const known = new Set(sessions.map((s) => s.id));
  const children = new Map<string, RemoteSession[]>();
  const roots: RemoteSession[] = [];
  for (const s of sessions) {
    if (s.parent !== null && known.has(s.parent)) {
      const list = children.get(s.parent);
      if (list === undefined) children.set(s.parent, [s]);
      else list.push(s);
    } else roots.push(s);
  }
  const out: Array<{ session: RemoteSession; depth: number }> = [];
  const seen = new Set<string>();
  const walk = (s: RemoteSession, depth: number): void => {
    if (seen.has(s.id)) return;
    seen.add(s.id);
    out.push({ session: s, depth });
    for (const c of children.get(s.id) ?? []) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return out;
}

/**
 * Сессии, что встают под строкой создателя (`createdBy`). Создатель должен сам стоять среди `shown`; цепочка
 * создателей, вернувшаяся к сессии, оставляет её на месте.
 */
function createdUnder(shown: readonly RemoteSession[]): { children: Map<string, RemoteSession[]>; placed: Set<string> } {
  const byId = new Map(shown.map((s) => [s.id, s]));
  const children = new Map<string, RemoteSession[]>();
  const placed = new Set<string>();
  for (const s of shown) {
    const creator = s.createdBy;
    if (creator === null || !byId.has(creator)) continue;
    const seen = new Set<string>();
    let up: string | null = creator;
    while (up !== null && up !== s.id && !seen.has(up)) {
      seen.add(up);
      up = byId.get(up)?.createdBy ?? null;
    }
    if (up === s.id) continue;
    const list = children.get(creator);
    if (list === undefined) children.set(creator, [s]);
    else list.push(s);
    placed.add(s.id);
  }
  return { children, placed };
}

/** Комната, в которой сессия стоит: открытая раньше архивной, дальше порядок снимка (даты создания в проекции нет). */
function homeRooms(work: RemoteWork): Map<string, RemoteRoom> {
  const home = new Map<string, RemoteRoom>();
  const open = work.rooms.filter((r) => !r.archived);
  const archived = work.rooms.filter((r) => r.archived);
  const known = new Set(work.sessions.map((s) => s.id));
  for (const room of [...open, ...archived]) {
    for (const id of room.members) if (known.has(id) && !home.has(id)) home.set(id, room);
  }
  return home;
}

function workRows(state: RemoteState, work: RemoteWork, showClosed: boolean): { rows: WorkRow[]; archivedRooms: RemoteRoom[] } {
  const home = homeRooms(work);
  const byId = new Map(work.sessions.map((s) => [s.id, s]));
  const activeRooms = work.rooms.filter((r) => !r.archived);
  const owners = new Set(activeRooms.flatMap((r) => (r.ownerId !== null ? [r.ownerId] : [])));
  const swarmSessions = new Set(work.swarms.flatMap((w) => w.members.map((m) => m.sessionId)));
  const live = (s: RemoteSession): ActivityEntry | null => state.activity[`${work.projectPath}\u0000${work.id}\u0000${s.id}`] ?? null;

  const own = treeOrder(work.sessions).filter(({ session }) => {
    if (swarmSessions.has(session.id)) return false;
    const room = home.get(session.id);
    const anchor = owners.has(session.id);
    return (
      (anchor || room === undefined || (room.archived && staysOnCard(session))) &&
      (anchor || showClosed || session.lifecycle !== 'closed')
    );
  });
  const created = createdUnder(own.map(({ session }) => session));
  const swarms = work.swarms.filter((w) => isSwarmShown(w, showClosed));
  const placed = new Set<string>();
  const rows: WorkRow[] = [];

  const pushSwarms = (matches: (w: RemoteSwarm) => boolean, depth: number, parent: string | null): void => {
    for (const swarm of swarms) {
      if (placed.has(swarm.id) || !matches(swarm)) continue;
      placed.add(swarm.id);
      rows.push({
        kind: 'swarm',
        swarm,
        depth,
        parent,
        members: [...swarm.members]
          .sort((a, b) => a.n - b.n)
          .map((member) => ({ member, session: byId.get(member.sessionId) ?? null })),
      });
    }
  };
  const roomRow = (room: RemoteRoom, depth: number, parent: string | null): WorkRow => {
    const sessions = room.members
      .map((id) => byId.get(id))
      .filter((s): s is RemoteSession => s !== undefined && home.get(s.id) === room && !(room.archived && staysOnCard(s)));
    return {
      kind: 'room',
      room,
      depth,
      parent,
      members: sessions.filter((s) => showClosed || s.lifecycle !== 'closed'),
      archived: room.archived,
    };
  };
  const pushRoom = (room: RemoteRoom, depth: number, parent: string | null): void => {
    rows.push(roomRow(room, depth, parent));
    pushSwarms((w) => w.creator.kind === 'room' && w.creator.roomId === room.id, depth + 1, room.id);
  };
  const push = (session: RemoteSession, depth: number, parent: string | null): void => {
    rows.push({ kind: 'session', session, depth, parent, attention: attentionOfSession(state, { projectPath: work.projectPath, workId: work.id, sessionId: session.id }, session), live: live(session) });
    for (const owned of activeRooms.filter((r) => r.ownerId === session.id)) pushRoom(owned, depth + 1, session.id);
    pushSwarms((w) => w.creator.kind === 'session' && w.creator.sessionId === session.id, depth + 1, session.id);
    for (const child of created.children.get(session.id) ?? []) push(child, depth + 1, session.id);
  };
  for (const { session, depth } of own) if (!created.placed.has(session.id)) push(session, depth, session.parent);
  for (const room of activeRooms) if (room.ownerId === null || !byId.has(room.ownerId)) pushRoom(room, 0, null);
  pushSwarms(() => true, 0, null);

  const archivedRooms = work.rooms.filter((r) => r.archived);
  return { rows, archivedRooms };
}

function workView(state: RemoteState, work: RemoteWork, showClosed: boolean): WorkView {
  let level: Attention = 'off';
  let needsYou = 0;
  let lastEventAt = '';
  const later = (iso: string | null): void => {
    if (iso !== null && ms(iso) > ms(lastEventAt || null)) lastEventAt = iso;
  };
  for (const s of work.sessions) {
    const ref = { projectPath: work.projectPath, workId: work.id, sessionId: s.id };
    const a = attentionOfSession(state, ref, s);
    if (a === 'needs-you') needsYou += 1;
    if (ATTENTION_RANK[a] > ATTENTION_RANK[level]) level = a;
    later(state.activity[`${ref.projectPath}\u0000${ref.workId}\u0000${ref.sessionId}`]?.activity.lastEventAt ?? null);
    later(s.lastEvent?.at ?? null);
    later(s.startedAt);
  }
  const decisions = work.rooms.filter((r) => !r.archived && r.proposal !== null).length;
  if (decisions > 0) {
    needsYou += decisions;
    level = 'needs-you';
  }
  const { rows, archivedRooms } = workRows(state, work, showClosed);
  return { key: workKeyOf(work.projectPath, work.id), work, level, needsYou, lastEventAt, rows, archivedRooms };
}

const tail = (w: RemoteWork): number => (w.status === 'archived' ? 2 : w.status === 'done' ? 1 : 0);

/**
 * Работы в порядке сайдбара: `done` и архивные внизу, выше — где нужен человек, затем по времени последнего события.
 * Работы одного проекта — подряд; проекты идут в порядке своей первой работы.
 */
export function selectWorks(state: RemoteState, options: WorksViewOptions = {}): ProjectGroup[] {
  const showClosed = options.showClosed ?? false;
  const views = (state.snapshot?.works ?? [])
    .filter((w) => showClosed || w.status !== 'archived')
    .map((w) => workView(state, w, showClosed))
    .sort((a, b) => {
      const byTail = tail(a.work) - tail(b.work);
      if (byTail !== 0) return byTail;
      const byRank = ATTENTION_RANK[b.level] - ATTENTION_RANK[a.level];
      if (byRank !== 0) return byRank;
      const at = ms(a.lastEventAt || null);
      const bt = ms(b.lastEventAt || null);
      if (at !== bt) return at < bt ? 1 : -1;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });
  const groups = new Map<string, ProjectGroup>();
  for (const v of views) {
    const g = groups.get(v.work.projectPath);
    if (g === undefined) groups.set(v.work.projectPath, { projectPath: v.work.projectPath, name: folderName(v.work.projectPath), works: [v] });
    else g.works.push(v);
  }
  return [...groups.values()];
}
