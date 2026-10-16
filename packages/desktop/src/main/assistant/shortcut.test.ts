import { describe, expect, it, vi } from 'vitest';
import { createAssistantShortcut } from './shortcut.js';

function registry(taken: string[] = []) {
  return { register: vi.fn((accelerator: string) => !taken.includes(accelerator)), unregister: vi.fn() };
}

describe('глобальный хоткей помощника', () => {
  it('включён — регистрирует; выключен — снимает', () => {
    const fake = registry();
    const shortcut = createAssistantShortcut({ registry: fake, onTrigger: vi.fn(), log: vi.fn() });
    expect(shortcut.sync(true, 'Alt+Space')).toEqual({ accelerator: 'Alt+Space', ok: true });
    expect(fake.register).toHaveBeenCalledTimes(1);
    shortcut.sync(true, 'Alt+Space');
    expect(fake.register).toHaveBeenCalledTimes(1);
    expect(shortcut.sync(false, 'Alt+Space')).toEqual({ accelerator: null, ok: true });
    expect(fake.unregister).toHaveBeenCalledWith('Alt+Space');
  });
  it('смена сочетания — снять старое, взять новое', () => {
    const fake = registry();
    const shortcut = createAssistantShortcut({ registry: fake, onTrigger: vi.fn(), log: vi.fn() });
    shortcut.sync(true, 'Alt+Space');
    shortcut.sync(true, 'Control+Alt+J');
    expect(fake.unregister).toHaveBeenCalledWith('Alt+Space');
    expect(fake.register).toHaveBeenLastCalledWith('Control+Alt+J', expect.any(Function));
  });
  it('занято — ok: false, и снимать нечего', () => {
    const fake = registry(['Alt+Space']);
    const shortcut = createAssistantShortcut({ registry: fake, onTrigger: vi.fn(), log: vi.fn() });
    expect(shortcut.sync(true, 'Alt+Space')).toEqual({ accelerator: 'Alt+Space', ok: false });
    shortcut.sync(false, 'Alt+Space');
    expect(fake.unregister).not.toHaveBeenCalled();
  });
  it('битое сочетание — ok: false, без исключения', () => {
    const fake = { register: vi.fn(() => { throw new Error('bad accelerator'); }), unregister: vi.fn() };
    const shortcut = createAssistantShortcut({ registry: fake, onTrigger: vi.fn(), log: vi.fn() });
    expect(shortcut.sync(true, 'Hyper+Q')).toEqual({ accelerator: 'Hyper+Q', ok: false });
  });
  it('нажатие зовёт onTrigger', () => {
    const fake = registry();
    const onTrigger = vi.fn();
    createAssistantShortcut({ registry: fake, onTrigger, log: vi.fn() }).sync(true, 'Alt+Space');
    (fake.register.mock.calls[0]?.[1] as () => void)();
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });
});
