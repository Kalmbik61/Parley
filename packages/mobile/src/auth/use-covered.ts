// The lock cover as a hook, for sheets that open by themselves (a finished run): they wait for the unlock instead of
// opening over the cover (critic A41b M1; LockGate: "nothing is opened under the cover"). The predicate is LockGate's own
// (`shouldCover`), including the app-switcher cover of an inactive app (critic m10).
import { useEffect, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { DEMO, DEV_LOCK_MS } from '../dev/flags';
import type { HostRecord } from '@parley/remote-client';
import { useRuntimeState } from '../runtime/use-runtime';
import { shouldCover } from './app-lock';
import { appLock } from './lock-instance';

const none = (): (() => void) => () => undefined;

/** Paired Macs: `null` while the list is not read yet (it is set before `ready`, so empty and booting means unknown). */
export const knownHosts = (hosts: readonly HostRecord[], phase: string): number | null => (hosts.length > 0 ? hosts.length : phase === 'ready' ? 0 : null);

export function useCovered(): boolean {
  const { phase, hosts } = useRuntimeState();
  const [active, setActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setActive(s === 'active'));
    return () => sub.remove();
  }, []);
  const count = knownHosts(hosts, phase);
  return useSyncExternalStore(
    (cb) => appLock()?.subscribe(cb) ?? none(),
    // The demo build without a lock draws no cover (LockGate).
    () => !(DEMO && DEV_LOCK_MS === null) && shouldCover(appLock(), active, count),
    () => true,
  );
}
