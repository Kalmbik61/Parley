/** Видимость для quiet Done: отдельна от seen tracker и не отправляет activity.seen. */
import { sessionRef, type SessionRef } from '@parley/protocol';
import type { ParleyBridge } from '../../shared/bridge.js';
import { SESSION_VISIBILITY_LIMIT } from '../../shared/island.js';
import { workKey } from '../../shared/work-keys.js';
import { panelRuntimeKey, usePanelRuntime } from '../browser/panel/runtime.js';
import { ownerKey } from '../layout/ids.js';
import { useLayoutStore } from '../layout/store.js';
import { useUiStore } from '../store/ui.js';

// Счётчик живёт до новой страницы, а не до переподключения хоста/эффекта App.
let seq = 0;

function visibleRefs(): SessionRef[] {
  const { layouts } = useLayoutStore.getState();
  const { hosts } = usePanelRuntime.getState();
  const refs: SessionRef[] = [];
  for (const key of Object.keys(useUiStore.getState().visibleSessionRefs).sort()) {
    const parts = key.split('\u0000');
    if (parts.length !== 3) continue;
    const parsed = sessionRef.safeParse({ projectPath: parts[0], workId: parts[1], sessionId: parts[2] });
    if (!parsed.success) continue;
    const ref = parsed.data;
    const owner = { kind: 'session' as const, sessionId: ref.sessionId };
    const work = workKey(ref.projectPath, ref.workId);
    const panel = layouts[work]?.panels?.[ownerKey(owner)];
    const host = hosts[panelRuntimeKey(work, owner)];
    if (panel?.open && (host === undefined || !host.measured || host.narrow)) continue;
    refs.push(ref);
    if (refs.length === SESSION_VISIBILITY_LIMIT) break;
  }
  return refs;
}

export function wireSessionVisibility(bridge: ParleyBridge): () => void {
  const publish = (): void => bridge.app.reportSessionVisibility({ refs: visibleRefs(), documentVisible: useUiStore.getState().documentVisible, seq: ++seq });
  const disposers = [
    useUiStore.subscribe((state, previous) => {
      if (state.visibleSessionRefs !== previous.visibleSessionRefs || state.documentVisible !== previous.documentVisible) publish();
    }),
    useLayoutStore.subscribe((state, previous) => { if (state.layouts !== previous.layouts) publish(); }),
    usePanelRuntime.subscribe((state, previous) => { if (state.hosts !== previous.hosts) publish(); }),
    bridge.app.onWindowFocus((focused) => { if (focused) publish(); }),
  ];
  publish();
  return () => {
    for (const dispose of disposers) dispose();
    bridge.app.reportSessionVisibility({ refs: [], documentVisible: false, seq: ++seq });
  };
}
