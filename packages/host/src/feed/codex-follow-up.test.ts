import { describe, expect, it } from 'vitest';
import type { FeedQuestion } from '@parley/core';
import { submitCodexFollowUp } from './codex-follow-up.js';

const shiftLeft = '\x1b[1;2D';
const header = '• Queued follow-up inputs';
const footer = '  enter submit   ⌃] skip   ⇧→ main prompt';
const choices: FeedQuestion = {
  question: 'Which color should we use?', multiSelect: false, header: null,
  options: ['Ocean blue', 'Forest green'].map(label => ({ label, description: null })),
};
const plain: FeedQuestion = { ...choices, question: 'Which size do you prefer?', options: [] };
const collapsed = ['? Some previous question', header, '  ? 1 question · 13s', '    ⇧← to answer', '', '› Ask Codex to do anything', '  ? for shortcuts'];
function editor(question = choices, text = '', position = ''): string[] {
  return [header, '', position, question.question, '',
    ...(question.options.length ? ['  › 1. Ocean blue', '    2. Forest green', '    3. ' + (text || 'Other')] : [text || 'Type your answer']),
    '', footer + (position ? '   ⇧← next question' : '')];
}
function scenario(screens: string[][]) {
  const writes: string[] = [];
  let i = 0;
  return {
    writes,
    io: { read: () => screens[i] ?? [], write: (key: string) => { writes.push(key); i++; }, sleep: async () => {} },
  };
}

describe('submitCodexFollowUp', () => {
  it('opens the advertised queue and chooses the matching label only in its editor', async () => {
    const { writes, io } = scenario([collapsed, editor()]);
    expect(await submitCodexFollowUp(io, choices, 'Forest green', [choices])).toBe(true);
    expect(writes).toEqual([shiftLeft, '2']);
  });

  it('verifies Other and the entire pasted answer before Enter', async () => {
    const selected = editor().map(line => line.replace('› 1.', '  1.').replace('  3.', '› 3.'));
    const typed = selected.map(line => line.replace('3. Other', '3. 24 items'));
    const { writes, io } = scenario([editor(), selected, typed]);
    expect(await submitCodexFollowUp(io, choices, '24 items', [choices])).toBe(true);
    expect(writes).toEqual(['3', '\x1b[200~24 items\x1b[201~', '\r']);
  });

  it('opens a queued free-text question and moves between verified questions', async () => {
    const { writes, io } = scenario([editor(choices, '', '1 of 2'), editor(plain, '', '2 of 2'), editor(plain, 'Large', '2 of 2')]);
    expect(await submitCodexFollowUp(io, plain, 'Large', [choices, plain])).toBe(true);
    expect(writes).toEqual([shiftLeft, '\x1b[200~Large\x1b[201~', '\r']);
  });

  it.each([
    ['plain prompt', ['› Ask Codex to do anything']],
    ['old queue above approval', [...collapsed, 'Would you like to run the following command?', 'Press enter to confirm or esc to cancel']],
    ['wrong editor', editor(plain)],
    ['changed options', editor().map(line => line.replace('Forest green', 'Yellow'))],
    ['ended editor above a new prompt', [...editor(), '› Ask Codex to do anything']],
  ] as const)('does not send an answer to a %s', async (_name, screen) => {
    const { writes, io } = scenario([[...screen]]);
    expect(await submitCodexFollowUp(io, choices, 'Ocean blue', [choices])).toBe(false);
    expect(writes).toEqual([]);
  });

  it('addresses an identical question only at its verified position', async () => {
    const second = { ...choices };
    const { writes, io } = scenario([editor(choices, '', '1 of 2'), editor(second, '', '2 of 2')]);
    expect(await submitCodexFollowUp(io, second, 'Ocean blue', [choices, second])).toBe(true);
    expect(writes).toEqual([shiftLeft, '1']);
    const ambiguous = scenario([editor()]);
    expect(await submitCodexFollowUp(ambiguous.io, second, 'Ocean blue', [choices, second])).toBe(false);
    expect(ambiguous.writes).toEqual([]);
  });

  it('submits a free-text answer beginning with a numbered list', async () => {
    const { io, writes } = scenario([editor(plain), editor(plain, '1. First item')]);
    expect(await submitCodexFollowUp(io, plain, '1. First item', [plain])).toBe(true);
    expect(writes.at(-1)).toBe('\r');
  });

  it('does not replace a terminal draft or submit after the editor changes', async () => {
    const draft = scenario([editor(plain, 'my draft')]);
    expect(await submitCodexFollowUp(draft.io, plain, 'Large', [plain])).toBe(false);
    expect(draft.writes).toEqual([]);
    const changed = scenario([editor(plain), editor(choices)]);
    expect(await submitCodexFollowUp(changed.io, plain, 'Large', [plain])).toBe(false);
    expect(changed.writes).toEqual(['\x1b[200~Large\x1b[201~']);
  });
});
