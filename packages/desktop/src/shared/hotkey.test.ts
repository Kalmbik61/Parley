import { describe, expect, it } from 'vitest';
import { acceleratorFromPress, hotkeyLabel, type HotkeyPress } from './hotkey.js';

const press = (code: string, mods: Partial<HotkeyPress> = {}): HotkeyPress => ({
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe('acceleratorFromPress', () => {
  it('Alt+Space', () => {
    expect(acceleratorFromPress(press('Space', { altKey: true }), true)).toBe('Alt+Space');
  });

  it('Command на mac и Super не на mac', () => {
    const shiftJ = press('KeyJ', { metaKey: true, shiftKey: true });
    expect(acceleratorFromPress(shiftJ, true)).toBe('Command+Shift+J');
    expect(acceleratorFromPress(shiftJ, false)).toBe('Super+Shift+J');
  });

  it('без модификатора — null', () => {
    expect(acceleratorFromPress(press('Space'), true)).toBeNull();
  });

  it('один модификатор — null', () => {
    expect(acceleratorFromPress(press('AltLeft', { altKey: true }), true)).toBeNull();
  });

  it('Escape — null', () => {
    expect(acceleratorFromPress(press('Escape', { altKey: true }), true)).toBeNull();
  });

  it('Control+Alt+Up', () => {
    expect(acceleratorFromPress(press('ArrowUp', { ctrlKey: true, altKey: true }), true)).toBe('Control+Alt+Up');
  });

  it('цифры, F-клавиши и знаки', () => {
    expect(acceleratorFromPress(press('Digit5', { ctrlKey: true }), true)).toBe('Control+5');
    expect(acceleratorFromPress(press('F12', { altKey: true }), true)).toBe('Alt+F12');
    expect(acceleratorFromPress(press('Backslash', { altKey: true }), true)).toBe('Alt+\\');
  });
});

describe('hotkeyLabel', () => {
  it('модификаторы символами', () => {
    expect(hotkeyLabel('Command+Shift+J')).toBe('⌘⇧J');
    expect(hotkeyLabel('Alt+Space')).toBe('⌥Space');
  });
});
