import type { WorksSnapshot } from '@parley/protocol';

/** Старый host может прислать private proof: ни RPC, ни event острова его не получают. */
export function projectIslandWorks(snapshot: WorksSnapshot): WorksSnapshot {
  return { ...snapshot, entries: snapshot.entries.map((entry) => ({
    ...entry, map: { ...entry.map, sessions: entry.map.sessions.map((session) => {
      const publicSession = { ...session };
      delete publicSession.codexThreadBinding;
      return publicSession;
    }) },
  })) };
}
