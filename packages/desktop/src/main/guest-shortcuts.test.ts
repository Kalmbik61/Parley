import { describe, expect, it, vi } from 'vitest';
import type { Input, WebContents } from 'electron';
import type { ActionId } from '../shared/keybindings.js';
import { forwardGuestShortcuts } from './guest-shortcuts.js';

type Listener = (event: { preventDefault(): void }, input: Input) => void;

/** Подставной webContents гостя: `forwardGuestShortcuts` трогает только `on` и `off`. */
function fakeGuest() {
  const listeners = new Map<string, Listener>();
  const on = vi.fn((name: string, listener: Listener) => {
    listeners.set(name, listener);
  });
  const off = vi.fn((name: string, listener: Listener) => {
    if (listeners.get(name) === listener) listeners.delete(name);
  });
  const contents = { on, off } as unknown as Pick<WebContents, 'on' | 'off'>;
  /** Нажатие в странице; отдаёт, погашено ли оно. */
  const input = (partial: Partial<Input>): boolean => {
    const event = { preventDefault: vi.fn() };
    listeners.get('before-input-event')?.(event, {
      type: 'keyDown',
      key: '',
      code: '',
      isAutoRepeat: false,
      isComposing: false,
      shift: false,
      control: false,
      alt: false,
      meta: false,
      location: 0,
      modifiers: [],
      ...partial,
    } as Input);
    return event.preventDefault.mock.calls.length > 0;
  };
  return { contents, on, off, input };
}

describe('forwardGuestShortcuts (тест 7)', () => {
  it('⌘J, ⌘F, ⌘=, ⌘0 — гасятся в госте и уходят окну', () => {
    const guest = fakeGuest();
    const send = vi.fn<(id: ActionId) => void>();
    forwardGuestShortcuts(guest.contents, send);

    expect(guest.input({ key: 'j', code: 'KeyJ', meta: true })).toBe(true);
    expect(guest.input({ key: 'f', code: 'KeyF', meta: true })).toBe(true);
    expect(guest.input({ key: '=', code: 'Equal', meta: true })).toBe(true);
    expect(guest.input({ key: '0', code: 'Digit0', meta: true })).toBe(true);
    expect(send.mock.calls.map(([id]) => id)).toEqual([
      'palette.open',
      'browser.find',
      'browser.zoomIn',
      'browser.zoomReset',
    ]);
  });

  it('keyUp и isComposing — не трогаются', () => {
    const guest = fakeGuest();
    const send = vi.fn<(id: ActionId) => void>();
    forwardGuestShortcuts(guest.contents, send);

    expect(guest.input({ type: 'keyUp', key: 'j', code: 'KeyJ', meta: true })).toBe(false);
    expect(guest.input({ key: 'j', code: 'KeyJ', meta: true, isComposing: true })).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('⌘C и ⌘⇧↓ — остаются странице; ⌘K (when terminal) — тоже', () => {
    const guest = fakeGuest();
    const send = vi.fn<(id: ActionId) => void>();
    forwardGuestShortcuts(guest.contents, send);

    expect(guest.input({ key: 'c', code: 'KeyC', meta: true })).toBe(false);
    expect(guest.input({ key: 'ArrowDown', code: 'ArrowDown', meta: true, shift: true })).toBe(false);
    expect(guest.input({ key: 'ArrowUp', code: 'ArrowUp', meta: true, shift: true })).toBe(false);
    expect(guest.input({ key: 'k', code: 'KeyK', meta: true })).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('отписка зовёт off с тем же слушателем', () => {
    const guest = fakeGuest();
    const send = vi.fn<(id: ActionId) => void>();
    const dispose = forwardGuestShortcuts(guest.contents, send);
    dispose();

    expect(guest.off).toHaveBeenCalledWith('before-input-event', guest.on.mock.calls[0]?.[1]);
    expect(guest.input({ key: 'j', code: 'KeyJ', meta: true })).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('⌃Tab и ⌃⇧Tab — остаются странице: keyUp ⌃ из гостя не долетит, цикл MRU не закончится (раунд исправлений 1)', () => {
    const guest = fakeGuest();
    const send = vi.fn<(id: ActionId) => void>();
    forwardGuestShortcuts(guest.contents, send);

    expect(guest.input({ key: 'Tab', code: 'Tab', control: true })).toBe(false);
    expect(guest.input({ key: 'Tab', code: 'Tab', control: true, shift: true })).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('автоповтор: ⌘N удержан — один send, повторы погашены; ⌘= удержан — каждый шаг', () => {
    const guest = fakeGuest();
    const send = vi.fn<(id: ActionId) => void>();
    forwardGuestShortcuts(guest.contents, send);

    expect(guest.input({ key: 'n', code: 'KeyN', meta: true })).toBe(true);
    expect(guest.input({ key: 'n', code: 'KeyN', meta: true, isAutoRepeat: true })).toBe(true);
    expect(guest.input({ key: 'n', code: 'KeyN', meta: true, isAutoRepeat: true })).toBe(true);
    expect(send.mock.calls.map(([id]) => id)).toEqual(['work.new']);

    send.mockClear();
    guest.input({ key: '=', code: 'Equal', meta: true });
    guest.input({ key: '=', code: 'Equal', meta: true, isAutoRepeat: true });
    expect(send.mock.calls.map(([id]) => id)).toEqual(['browser.zoomIn', 'browser.zoomIn']);
  });
});
