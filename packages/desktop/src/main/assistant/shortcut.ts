/**
 * Глобальное сочетание помощника (спека 2026-10-14, 8.1) — первое в Parley: работает из любого приложения.
 * `register` возвращает `false`, если сочетание держит другое приложение; тогда помощник доступен кликом и палитрой.
 */

import type { AssistantShortcutStatus } from '../../shared/island.js';

export interface ShortcutRegistry {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

export function createAssistantShortcut(deps: { registry: ShortcutRegistry; onTrigger(): void; log(line: string): void }): {
  sync(enabled: boolean, accelerator: string): AssistantShortcutStatus;
  status(): AssistantShortcutStatus;
} {
  let current: string | null = null;
  let ok = true;
  return {
    sync(enabled, accelerator) {
      const wanted = enabled ? accelerator : null;
      if (wanted === current && (wanted === null || ok)) return { accelerator: current, ok };
      if (current !== null && ok) deps.registry.unregister(current);
      current = wanted;
      ok = true;
      if (wanted !== null) {
        try {
          ok = deps.registry.register(wanted, deps.onTrigger);
        } catch (error) {
          ok = false;
          deps.log(`assistant: bad shortcut ${wanted}: ${(error as Error).message}`);
        }
        if (!ok) deps.log(`assistant: shortcut ${wanted} is not available`);
      }
      return { accelerator: current, ok };
    },
    status: () => ({ accelerator: current, ok }),
  };
}
