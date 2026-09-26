import { describe, expect, it } from 'vitest';
import { shouldForwardToTerminal } from './keys.js';

describe('shouldForwardToTerminal', () => {
  it('⌘-сочетание — не для xterm', () => {
    expect(shouldForwardToTerminal({ metaKey: true })).toBe(false);
  });

  it('обычная клавиша — для xterm', () => {
    expect(shouldForwardToTerminal({ metaKey: false })).toBe(true);
  });
});
