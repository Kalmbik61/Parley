import type { AssistantShortcutStatus } from '../../shared/island.js';
import type { ShortcutRegistry } from '../assistant/shortcut.js';

/** Separate owner for the island queue shortcut; it never releases another feature's accelerator. */
export function createIslandShortcut(deps: {
  registry: ShortcutRegistry; onTrigger(): void; log(line: string): void;
}): {
  sync(enabled: boolean, accelerator: string | null): AssistantShortcutStatus;
  status(): AssistantShortcutStatus;
  suspend(on: boolean): void;
  dispose(): void;
} {
  let current: string | null = null;
  let ok = true;
  let suspended = false;
  let disposed = false;
  const attempt = (accelerator: string): boolean => {
    try {
      const registered = deps.registry.register(accelerator, deps.onTrigger);
      if (!registered) deps.log(`island: shortcut ${accelerator} is not available`);
      return registered;
    } catch (error) {
      deps.log(`island: bad shortcut ${accelerator}: ${(error as Error).message}`);
      return false;
    }
  };
  const release = (): void => {
    if (current !== null && ok && !suspended) deps.registry.unregister(current);
  };
  return {
    sync(enabled, accelerator) {
      const wanted = !disposed && enabled ? accelerator : null;
      if (wanted === current && (wanted === null || ok)) return { accelerator: current, ok };
      release();
      current = wanted;
      ok = true;
      if (wanted !== null && !suspended) ok = attempt(wanted);
      return { accelerator: current, ok };
    },
    status: () => ({ accelerator: current, ok }),
    suspend(on) {
      if (on === suspended || disposed) return;
      if (on) {
        if (current !== null && ok) deps.registry.unregister(current);
        suspended = true;
      } else {
        suspended = false;
        if (current !== null) ok = attempt(current);
      }
    },
    dispose() {
      if (disposed) return;
      release();
      current = null;
      disposed = true;
      ok = false;
    },
  };
}
