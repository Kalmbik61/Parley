import { describe, expect, it } from 'vitest';
import { shouldForwardToTerminal } from './keys.js';

function key(partial: Partial<Parameters<typeof shouldForwardToTerminal>[0]>): Parameters<typeof shouldForwardToTerminal>[0] {
  return { metaKey: false, ctrlKey: false, shiftKey: false, key: '', ...partial };
}

describe('shouldForwardToTerminal', () => {
  it('⌘-сочетание — не для xterm', () => {
    expect(shouldForwardToTerminal(key({ metaKey: true, key: 't' }))).toBe(false);
  });

  it('обычная клавиша — для xterm', () => {
    expect(shouldForwardToTerminal(key({ metaKey: false, key: 'a' }))).toBe(true);
  });

  // Тест 5 куска 2.4: ⌃Tab, ⌃1 — окну (layout/keys.ts), не xterm; ⌃C, ⌃A — обычные
  // терминальные сочетания, xterm получает их сам.
  it('⌃Tab — не для xterm (MRU вкладок)', () => {
    expect(shouldForwardToTerminal(key({ ctrlKey: true, key: 'Tab' }))).toBe(false);
  });

  it('⌃⇧Tab — тоже не для xterm', () => {
    expect(shouldForwardToTerminal(key({ ctrlKey: true, shiftKey: true, key: 'Tab' }))).toBe(false);
  });

  it('⌃1 — не для xterm (вкладка по номеру)', () => {
    expect(shouldForwardToTerminal(key({ ctrlKey: true, key: '1' }))).toBe(false);
  });

  it('⌃C — для xterm (SIGINT)', () => {
    expect(shouldForwardToTerminal(key({ ctrlKey: true, key: 'c' }))).toBe(true);
  });

  it('⌃A — для xterm (в начало строки)', () => {
    expect(shouldForwardToTerminal(key({ ctrlKey: true, key: 'a' }))).toBe(true);
  });
});
