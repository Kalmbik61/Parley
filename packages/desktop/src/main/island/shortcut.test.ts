import { describe, expect, it, vi } from 'vitest';
import { createIslandShortcut } from './shortcut.js';

function fixture(taken: string[] = []) {
  const registry = {
    register: vi.fn((accelerator: string) => !taken.includes(accelerator)),
    unregister: vi.fn(),
  };
  const onTrigger = vi.fn();
  const log = vi.fn();
  return { registry, onTrigger, log, shortcut: createIslandShortcut({ registry, onTrigger, log }) };
}

describe('island pending shortcut', () => {
  it('registers only when enabled; disconnect releases it and reconnect can register again', () => {
    const { registry, shortcut, onTrigger } = fixture();
    expect(shortcut.sync(false, 'Control+Alt+I')).toEqual({ accelerator: null, ok: true });
    expect(registry.register).not.toHaveBeenCalled();
    expect(shortcut.sync(true, 'Control+Alt+I')).toEqual({ accelerator: 'Control+Alt+I', ok: true });
    expect(registry.register).toHaveBeenCalledTimes(1);
    registry.register.mock.calls[0]?.[1]?.();
    expect(onTrigger).toHaveBeenCalledOnce();
    expect(shortcut.sync(false, 'Control+Alt+I')).toEqual({ accelerator: null, ok: true });
    expect(registry.unregister).toHaveBeenCalledWith('Control+Alt+I');
    expect(shortcut.sync(true, 'Control+Alt+I').ok).toBe(true);
    expect(registry.register).toHaveBeenCalledTimes(2);
  });

  it('reports a conflict without unregistering a shortcut owned elsewhere', () => {
    const { registry, shortcut } = fixture(['Control+Alt+I']);
    expect(shortcut.sync(true, 'Control+Alt+I')).toEqual({ accelerator: 'Control+Alt+I', ok: false });
    expect(shortcut.status()).toEqual({ accelerator: 'Control+Alt+I', ok: false });
    expect(registry.unregister).not.toHaveBeenCalled();
  });

  it('suspends only its own registration during recording and disposes it', () => {
    const { registry, shortcut } = fixture();
    shortcut.sync(true, 'Control+Alt+I');
    shortcut.suspend(true);
    expect(registry.unregister).toHaveBeenCalledWith('Control+Alt+I');
    expect(shortcut.status().accelerator).toBe('Control+Alt+I');
    shortcut.sync(true, 'Control+Alt+J');
    expect(registry.register).toHaveBeenCalledTimes(1);
    shortcut.suspend(false);
    expect(registry.register).toHaveBeenLastCalledWith('Control+Alt+J', expect.any(Function));
    shortcut.dispose();
    expect(registry.unregister).toHaveBeenLastCalledWith('Control+Alt+J');
    expect(shortcut.sync(true, 'Control+Alt+I')).toEqual({ accelerator: null, ok: false });
  });
});
