// Letters keeps read letters too (D1 §10.2): the client only pulls the newest page for UNREAD ones, so the screen asks
// for the newest page of every work itself, once per opening.
import { useEffect } from 'react';
import { runtime } from '../runtime/instance';
import { useRuntimeState } from '../runtime/use-runtime';

export function useLoadLetters(): void {
  const { client, supervisor } = useRuntimeState();
  const ready = supervisor?.state === 'ready';
  useEffect(() => {
    if (!client || !ready) return;
    const { store } = client;
    const epoch = store.getState().epoch;
    for (const work of store.getState().snapshot?.works ?? []) {
      void runtime
        .call('context.messages', { projectPath: work.projectPath, workId: work.id, roomId: null })
        .then((res) => {
          const messages = (res as { messages?: unknown } | null)?.messages;
          if (Array.isArray(messages)) {
            store.dispatch({ t: 'messages', projectPath: work.projectPath, workId: work.id, roomId: null, messages: messages as never[], epoch });
          }
        })
        .catch(() => undefined);
    }
  }, [client, ready]);
}
