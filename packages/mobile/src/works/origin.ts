// "Whose session is this" line of the Session screen (D1 §9): the path from the main session down to this one.
import type { RemoteWork } from '@parley/protocol/remote';

export interface OriginStep {
  kind: 'session' | 'room' | 'swarm';
  id: string;
  label: string;
}

/** Empty for a main session. Created sessions, room members and swarm members each add their container. */
export function originOf(work: RemoteWork, sessionId: string): OriginStep[] {
  const byId = new Map(work.sessions.map((s) => [s.id, s]));
  const path: OriginStep[] = [];
  const seen = new Set<string>();
  let current = byId.get(sessionId);
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    const swarm = work.swarms.find((w) => w.members.some((m) => m.sessionId === current!.id));
    const room = work.rooms.find((r) => !r.archived && r.members.includes(current!.id) && r.ownerId !== current!.id);
    let next: string | null = null;
    if (swarm !== undefined) {
      path.unshift({ kind: 'swarm', id: swarm.id, label: `Swarm [${swarm.tag}]` });
      next = swarm.creator.kind === 'session' ? swarm.creator.sessionId : null;
    } else if (room !== undefined) {
      path.unshift({ kind: 'room', id: room.id, label: `# ${room.title}` });
      next = room.ownerId;
    } else {
      next = current.createdBy ?? current.parent;
    }
    if (next === null) break;
    const owner = byId.get(next);
    if (owner === undefined) break;
    path.unshift({ kind: 'session', id: owner.id, label: owner.label });
    current = owner;
  }
  return path;
}
