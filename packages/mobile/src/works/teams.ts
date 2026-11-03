// Teams of the Work screen (D1 §8.2): the flat rows of `selectWorks` cut into one card per main session, with counts,
// waiting-for-you totals, the three-level depth cap and the "N more under …" link. Pure.
import type { RemoteSession } from '@parley/protocol/remote';
import type { WorkRow } from '@parley/remote-client';

export const MAX_DEPTH = 2;

export const rowId = (row: WorkRow): string =>
  row.kind === 'session' ? row.session.id : row.kind === 'room' ? row.room.id : row.swarm.id;

export interface TeamCounts {
  agents: number;
  rooms: number;
  swarms: number;
}

export interface MoreLink {
  count: number;
  /** The last shown session whose subtree is cut; its Session screen continues the tree. */
  underSessionId: string;
  underLabel: string;
}

export interface Team {
  id: string;
  head: WorkRow;
  /** Rows below the head, depth relative to the head (1 = direct child), capped at `MAX_DEPTH`. */
  children: Array<{ row: WorkRow; depth: number }>;
  counts: TeamCounts;
  needsYou: number;
  more: MoreLink | null;
  /** A session without anything under it: such teams that follow each other share one card. */
  single: boolean;
}

/** Waiting-for-you counter inputs: how many of a row's sessions need the human. */
export interface NeedsYouOf {
  session(s: RemoteSession): boolean;
  room(row: Extract<WorkRow, { kind: 'room' }>): boolean;
}

/**
 * Counts of a set of rows: agents (sessions, room members, swarm members that still exist, each once), rooms, swarms.
 * The team header and the Team sheet count the same way. `extraAgent` — a session that heads the rows but is not among them.
 */
export function countRows(rows: readonly WorkRow[], extraAgent?: string): TeamCounts {
  const agents = new Set<string>(extraAgent === undefined ? [] : [extraAgent]);
  let rooms = 0;
  let swarms = 0;
  for (const row of rows) {
    if (row.kind === 'session') agents.add(row.session.id);
    else if (row.kind === 'room') {
      rooms++;
      for (const m of row.members) agents.add(m.id);
    } else {
      swarms++;
      for (const m of row.members) if (m.session !== null) agents.add(m.session.id);
    }
  }
  return { agents: agents.size, rooms, swarms };
}

/** Ids of closed sessions among the rows (session rows, room members, swarm members). */
function closedIds(rows: readonly WorkRow[]): Set<string> {
  const closed = new Set<string>();
  const add = (s: RemoteSession | null): void => {
    if (s !== null && s.lifecycle === 'closed') closed.add(s.id);
  };
  for (const row of rows) {
    if (row.kind === 'session') add(row.session);
    else if (row.kind === 'room') row.members.forEach(add);
    else row.members.forEach((m) => add(m.session));
  }
  return closed;
}

/**
 * What "N more closed" would add: closed sessions in the full rows that the shown rows do not already contain
 * (a closed room anchor or a closed member of a shown swarm is visible without expanding).
 */
export function closedAdded(full: readonly WorkRow[], shown: readonly WorkRow[]): number {
  const visible = closedIds(shown);
  let n = 0;
  for (const id of closedIds(full)) if (!visible.has(id)) n++;
  return n;
}

export function buildTeams(rows: readonly WorkRow[], needs: NeedsYouOf): Team[] {
  const seen = new Set<string>();
  const groups: WorkRow[][] = [];
  for (const row of rows) {
    const inTeam = row.parent !== null && seen.has(row.parent) && groups.length > 0;
    seen.add(rowId(row));
    if (inTeam) groups[groups.length - 1]!.push(row);
    else groups.push([row]);
  }
  return groups.map((g) => {
    const head = g[0]!;
    const all = g.slice(1).map((row) => ({ row, depth: row.depth - head.depth }));
    const shown = all.filter((x) => x.depth <= MAX_DEPTH);
    const cut = all.filter((x) => x.depth > MAX_DEPTH);
    let more: MoreLink | null = null;
    if (cut.length > 0) {
      // The cut subtree hangs under the nearest shown session before the first cut row.
      const firstCut = all.indexOf(cut[0]!);
      const owner = [...all.slice(0, firstCut)].reverse().find((x) => x.row.kind === 'session' && x.depth === MAX_DEPTH);
      if (owner?.row.kind === 'session') more = { count: cut.length, underSessionId: owner.row.session.id, underLabel: owner.row.session.label };
    }
    const counts = countRows([head, ...all.map((x) => x.row)]);
    let needsYou = 0;
    for (const { row } of [{ row: head }, ...all]) {
      if (row.kind === 'session') {
        if (needs.session(row.session)) needsYou++;
      } else if (row.kind === 'room') {
        for (const m of row.members) if (needs.session(m)) needsYou++;
        if (needs.room(row)) needsYou++;
      }
    }
    return {
      id: rowId(head),
      head,
      children: shown,
      counts,
      needsYou,
      more,
      single: head.kind === 'session' && g.length === 1,
    };
  });
}

/** `Team · 14 agents · 1 room · 1 swarm` (D1 §8.2). */
export function teamLine(c: TeamCounts): string {
  const parts = [`${c.agents} agent${c.agents === 1 ? '' : 's'}`];
  if (c.rooms > 0) parts.push(`${c.rooms} room${c.rooms === 1 ? '' : 's'}`);
  if (c.swarms > 0) parts.push(`${c.swarms} swarm${c.swarms === 1 ? '' : 's'}`);
  return `Team · ${parts.join(' · ')}`;
}

/** The subtree under one session row (for the Team section of the Session screen), depth relative to that session. */
export function subtreeOf(rows: readonly WorkRow[], sessionId: string): Array<{ row: WorkRow; depth: number }> {
  const at = rows.findIndex((r) => r.kind === 'session' && r.session.id === sessionId);
  if (at < 0) return [];
  const base = rows[at]!.depth;
  // By `parent`, like `buildTeams`: a row indented under the session but whose parent is not shown (a hidden closed parent)
  // is not in its team, so the sheet and the team header count the same rows.
  const inside = new Set<string>([sessionId]);
  const out: Array<{ row: WorkRow; depth: number }> = [];
  for (let i = at + 1; i < rows.length && rows[i]!.depth > base; i++) {
    const row = rows[i]!;
    if (row.parent === null || !inside.has(row.parent)) continue;
    inside.add(rowId(row));
    out.push({ row, depth: row.depth - base });
  }
  return out;
}

/** Default expansion (D1 §8.2): a team starts open when somebody inside works, waits or has finished a turn (rank ≥ 2). */
export function teamOpenByDefault(attentions: readonly string[]): boolean {
  return attentions.some((a) => a === 'needs-you' || a === 'unseen' || a === 'working');
}

/**
 * How the head of a team is drawn and what a tap on it does. A room or a swarm with no owning session (a person made it,
 * `ownerId: null`) is a top-level team head: it is the room's / swarm's own container, never a session card with a letter.
 */
export type HeadLook = { kind: 'session'; sessionId: string } | { kind: 'room'; roomId: string } | { kind: 'swarm'; swarmId: string };

export function headLook(head: WorkRow): HeadLook {
  if (head.kind === 'room') return { kind: 'room', roomId: head.room.id };
  if (head.kind === 'swarm') return { kind: 'swarm', swarmId: head.swarm.id };
  return { kind: 'session', sessionId: head.session.id };
}

/**
 * "N more closed" of the Team sheet: what expanding adds under the session. Both trees are fixed (collapsed and full), never
 * the tree the screen shows: after expanding that one already holds the closed rows and the count would drop to 0.
 */
export function sheetClosedCount(collapsed: readonly WorkRow[], full: readonly WorkRow[], sessionId: string): number {
  const under = (rows: readonly WorkRow[]): WorkRow[] => subtreeOf(rows, sessionId).map((x) => x.row);
  return closedAdded(under(full), under(collapsed));
}
