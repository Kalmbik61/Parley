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
  suspend(on: boolean): void;
} {
  let current: string | null = null;
  let ok = true;
  let suspended = false;

  function tryRegister(accelerator: string): boolean {
    let registered = false;
    try {
      registered = deps.registry.register(accelerator, deps.onTrigger);
    } catch (error) {
      deps.log(`assistant: bad shortcut ${accelerator}: ${(error as Error).message}`);
    }
    if (!registered) deps.log(`assistant: shortcut ${accelerator} is not available`);
    return registered;
  }

  return {
    sync(enabled, accelerator) {
      const wanted = enabled ? accelerator : null;
      if (wanted === current && (wanted === null || ok)) return { accelerator: current, ok };
      if (current !== null && ok && !suspended) deps.registry.unregister(current);
      current = wanted;
      ok = true;
      if (wanted !== null && !suspended) ok = tryRegister(wanted);
      return { accelerator: current, ok };
    },
    status: () => ({ accelerator: current, ok }),
    /**
     * На время записи сочетания в Settings снимаем текущее глобальное: пока оно зарегистрировано, система отдаёт
     * нажатие хоткею, и поле записи не получает собственное сочетание. `sync` в паузе только запоминает новое.
     */
    suspend(on) {
      if (on === suspended) return;
      suspended = on;
      if (on) {
        if (current !== null && ok) deps.registry.unregister(current);
      } else if (current !== null) {
        ok = tryRegister(current);
      }
    },
  };
}
