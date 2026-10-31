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
    const agents = new Set<string>();
    let rooms = 0;
    let swarms = 0;
    let needsYou = 0;
    for (const { row } of [{ row: head }, ...all]) {
      if (row.kind === 'session') {
        agents.add(row.session.id);
        if (needs.session(row.session)) needsYou++;
      } else if (row.kind === 'room') {
        rooms++;
        for (const m of row.members) {
          agents.add(m.id);
          if (needs.session(m)) needsYou++;
        }
        if (needs.room(row)) needsYou++;
      } else {
        swarms++;
        for (const m of row.members) if (m.session !== null) agents.add(m.session.id);
      }
    }
    return {
      id: rowId(head),
      head,
      children: shown,
      counts: { agents: agents.size, rooms, swarms },
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
  const out: Array<{ row: WorkRow; depth: number }> = [];
  for (let i = at + 1; i < rows.length && rows[i]!.depth > base; i++) out.push({ row: rows[i]!, depth: rows[i]!.depth - base });
  return out;
}

/** Default expansion (D1 §8.2): a team starts open when somebody inside works, waits or has finished a turn (rank ≥ 2). */
export function teamOpenByDefault(attentions: readonly string[]): boolean {
  return attentions.some((a) => a === 'needs-you' || a === 'unseen' || a === 'working');
}
