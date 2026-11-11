// @vitest-environment node
// The window's texts for the closed Code Mode reasons are core's list, word for word (plan T12a-indicator). Node, not jsdom: it imports core.
import { describe, expect, it } from 'vitest';
import { CODE_MODE_REASONS } from '@parley/core';
import { S } from '../../shared/strings.js';

describe('the window and core share one closed list of Code Mode reasons', () => {
  it('the window has a text for every closed reason of core, and no other', () => {
    expect(Object.keys(S.codeMode.reasons).sort()).toEqual(Object.keys(CODE_MODE_REASONS).sort());
  });
  it('the window shows no reason for provider-unproven (human decision m-7348); each other full sentence is core\'s own sentence, each short text short and plain', () => {
    expect(S.codeMode.reasons['provider-unproven']).toBeNull();
    for (const [key, text] of Object.entries(S.codeMode.reasons)) {
      if (key === 'provider-unproven') continue;
      expect(text, key).not.toBeNull();
      expect(text!.full, key).toBe(CODE_MODE_REASONS[key as keyof typeof CODE_MODE_REASONS]);
      expect(text!.short.length, key).toBeLessThanOrEqual(28);
      expect(text!.short, key).toMatch(/^[a-z][A-Za-z ]*$/);
    }
  });
  it('no string the window can show says Code Mode is unproven', () => {
    // Values only: the closed reason keys (provider-unproven) are never shown.
    const values = (node: unknown): string[] => (typeof node === 'string' ? [node] : node !== null && typeof node === 'object' ? Object.values(node).flatMap(values) : []);
    for (const text of values([S.codeMode, S.settings.codeMode, S.settings.codeModeState])) expect(text).not.toMatch(/unproven|not (yet )?proven/i);
  });
});

