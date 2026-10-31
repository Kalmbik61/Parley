import type { AppState, Subscribable } from '@parley/remote-client';

/** The slice of React Native's `AppState` used here. */
export interface AppStateLike {
  currentState: string | null | undefined;
  addEventListener(type: 'change', listener: (state: string) => void): { remove(): void };
}

/**
 * `active` stays `active` while iOS reports the transient `inactive` (Control Center, the app switcher, a system
 * sheet); only `background` moves the app to the background state the supervisor reacts to.
 */
export function createAppStateSource(appState: AppStateLike): Subscribable<AppState> {
  const map = (s: string | null | undefined, prev: AppState): AppState =>
    s === 'active' ? 'active' : s === 'background' ? 'background' : prev;
  let current = map(appState.currentState, 'active');
  const listeners = new Set<(v: AppState) => void>();
  let sub: { remove(): void } | null = null;
  return {
    get: () => current,
    subscribe(listener) {
      listeners.add(listener);
      sub ??= appState.addEventListener('change', (s) => {
        const next = map(s, current);
        if (next === current) return;
        current = next;
        for (const l of [...listeners]) l(next);
      });
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          sub?.remove();
          sub = null;
        }
      };
    },
  };
}
