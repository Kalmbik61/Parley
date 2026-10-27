import { progressResult, refKey, sessionRef, type ProgressResult, type SessionRef } from '@parley/protocol';
import { decodeIpcError } from '../../shared/ipc-error.js';

export type ProgressState = { kind: 'loading' } | { kind: 'unavailable' } |
  { kind: 'available'; result: ProgressResult; delayed: boolean };
export interface ProgressSelection {
  ref: SessionRef | null;
  active: boolean;
  connectionGeneration: number;
  lifecycle: string;
  methods: readonly string[] | null;
}

/** Один underlying IPC на остров: deadline отменяет delivery, но не освобождает незавершённый вызов. */
export function createProgressPoller(options: {
  call: (method: 'feed.progress', params: { ref: SessionRef }) => Promise<unknown>;
  onChange(state: ProgressState): void;
}) {
  let state: ProgressState = { kind: 'loading' };
  let target: SessionRef | null = null;
  let scope: string | null = null;
  let active = false;
  let supported = false;
  let disabled = false;
  let disposed = false;
  let version = 0;
  let expected = -1;
  let readyAt = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let flight: { version: number; expired: boolean; deadline?: ReturnType<typeof setTimeout> | undefined } | null = null;
  const publish = (next: ProgressState): void => { state = next; options.onChange(next); };
  const delayed = (): void => publish(state.kind === 'available' ? { ...state, delayed: true } : { kind: 'loading' });
  const clearRetry = (): void => { clearTimeout(retry); retry = undefined; };
  const canRun = (): boolean => !disposed && active && supported && !disabled && target !== null;

  function schedule(delay = 500): void {
    clearRetry();
    if (canRun()) retry = setTimeout(run, Math.max(500, delay));
  }

  function run(): void {
    clearRetry();
    if (!canRun() || flight !== null || target === null) return;
    const wait = readyAt - Date.now();
    if (wait > 0) { retry = setTimeout(run, wait); return; }
    const ref = { ...target };
    const current = { version, expired: false, deadline: undefined as ReturnType<typeof setTimeout> | undefined };
    flight = current;
    const deliver = (): boolean => !disposed && active && current.version === version && !current.expired;
    current.deadline = setTimeout(() => {
      if (!deliver()) return;
      current.expired = true;
      publish(state.kind === 'available' ? { ...state, delayed: true } : { kind: 'unavailable' });
    }, 2000);
    void (async () => {
      let delay = 500;
      try {
        const result = progressResult.safeParse(await options.call('feed.progress', { ref }));
        if (!deliver()) return;
        if (!result.success) { publish({ kind: 'unavailable' }); return; }
        if (result.data.availability === 'unavailable') publish({ kind: 'unavailable' });
        else if (result.data.revision >= expected) {
          expected = result.data.revision;
          publish({ kind: 'available', result: result.data, delayed: false });
        }
      } catch (error) {
        if (!deliver()) return;
        const info = decodeIpcError(error);
        const after = info.data?.retryAfterMs;
        if (info.code === 'conflict' && info.data?.reason === 'island-progress-rate-limit' &&
            typeof after === 'number' && Number.isFinite(after) && after >= 0 && after <= 250) {
          delayed();
          delay = Math.max(500, after);
        } else {
          publish({ kind: 'unavailable' });
          if (info.code === 'unknown_method') disabled = true;
        }
      } finally {
        clearTimeout(current.deadline);
        if (flight === current) flight = null;
        readyAt = Date.now() + Math.max(500, delay);
        schedule(delay);
      }
    })();
  }

  return {
    update(selection: ProgressSelection): void {
      if (disposed) return;
      const parsed = sessionRef.strict().safeParse(selection.ref);
      const ref = parsed.success && Object.values(parsed.data).every((part) => part.length > 0) ? parsed.data : null;
      const nextScope = JSON.stringify([ref === null ? null : refKey(ref), selection.connectionGeneration, selection.lifecycle]);
      const nextSupported = ref !== null && selection.methods?.includes('feed.progress') === true;
      if (nextScope === scope && active === selection.active && supported === nextSupported) return;
      version += 1;
      clearRetry();
      if (flight !== null) clearTimeout(flight.deadline);
      const changed = nextScope !== scope;
      if (changed) { expected = -1; disabled = false; }
      scope = nextScope;
      target = ref;
      active = selection.active;
      supported = nextSupported;
      if (!supported) publish({ kind: 'unavailable' });
      else if (active) {
        if (changed || state.kind !== 'available') publish({ kind: 'loading' });
        else delayed();
        run();
      }
    },
    dispose(): void {
      disposed = true;
      version += 1;
      clearRetry();
      if (flight !== null) clearTimeout(flight.deadline);
    },
  };
}
