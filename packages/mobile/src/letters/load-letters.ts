// Letters keeps read letters too (D1 §10.2): the client only pulls the newest page for UNREAD ones, so the screen asks
// for the newest page of each work itself, once per work and bridge epoch (re-opening the screen does not reload).
import { useEffect } from 'react';
import { runtime } from '../runtime/instance';
import { useRuntimeState } from '../runtime/use-runtime';

/** `epoch` → works already asked. A new epoch starts over. */
const asked = new Map<string, Set<string>>();

export function useLoadLetters(): void {
  const { client, supervisor } = useRuntimeState();
  const ready = supervisor?.state === 'ready';
  useEffect(() => {
    if (!client || !ready) return;
    const { store } = client;
    const epoch = store.getState().epoch;
    const key = epoch ?? '';
    if (!asked.has(key)) {
      asked.clear();
      asked.set(key, new Set());
    }
    const done = asked.get(key)!;
    for (const work of store.getState().snapshot?.works ?? []) {
      const workKey = `${work.projectPath}\u0000${work.id}`;
      if (done.has(workKey)) continue;
      done.add(workKey);
      void runtime
        .call('context.messages', { projectPath: work.projectPath, workId: work.id, roomId: null })
        .then((res) => {
          const messages = (res as { messages?: unknown } | null)?.messages;
          if (Array.isArray(messages)) {
            store.dispatch({ t: 'messages', projectPath: work.projectPath, workId: work.id, roomId: null, messages: messages as never[], epoch });
          }
        })
        .catch(() => void done.delete(workKey));
    }
  }, [client, ready]);
}
