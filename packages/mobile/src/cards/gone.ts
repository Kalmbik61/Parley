// "Answered at your Mac" (spec §10.3): a card that vanished from the host's answer stays for 2 s, then is dismissed.
import { useEffect } from 'react';
import type { GoneCard, RemoteClient, RemoteState } from '@parley/remote-client';

export const GONE_MS = 2000;

export interface GoneEntry {
  key: string;
  gone: GoneCard;
  /** Session label and work title looked up in the snapshot (for the Inbox row). */
  sessionLabel: string;
  workTitle: string;
}

export function goneEntries(state: RemoteState): GoneEntry[] {
  return Object.entries(state.gone).map(([key, gone]) => {
    const [projectPath, workId, sessionId] = gone.sessionKey.split('\u0000');
    const work = state.snapshot?.works.find((w) => w.projectPath === projectPath && w.id === workId);
    return {
      key,
      gone,
      sessionLabel: work?.sessions.find((s) => s.id === sessionId)?.label ?? 'Session',
      workTitle: work?.title ?? '',
    };
  });
}

/** Dismiss each entry 2 s after it appeared (`gone.at` is the client clock). */
export function useGoneDismiss(client: RemoteClient | null, entries: readonly GoneEntry[]): void {
  const keys = entries.map((e) => e.key).join('\u0001');
  useEffect(() => {
    if (client === null) return;
    const timers = entries.map((e) =>
      setTimeout(() => client.store.dispatch({ t: 'gone.dismiss', key: e.key }), Math.max(0, e.gone.at + GONE_MS - Date.now())),
    );
    return () => timers.forEach(clearTimeout);
  }, [client, keys]);
}
