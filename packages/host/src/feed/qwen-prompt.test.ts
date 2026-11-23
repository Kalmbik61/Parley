import { describe, expect, it, vi } from 'vitest';
import { answerQwenPrompt, recogniseQwenPrompt } from './qwen-prompt.js';

const wait = '⠏ Waiting for user confirmation...';
const nav = ' ↑/↓: Navigate | ←/→: Switch tabs | Enter: Select | Esc: Cancel';
const header = '? AskUserQuestion Ask user 2 questions ←';
const nativeQuestion = [header, ' ▸ Colour   Sizes  Submit', '', ' Which colour?', '',
  '   ❯ 1. Blue', '        Ocean blue', '     2. Green', '        Leaf green', '     3. Type something...', nav, wait];
const review = [header, ' Colour ✓  Sizes  ▸ Submit', '', ' Your answers:', '   Colour: Green', '   Sizes: (not answered)',
  '', ' Ready to submit your answers?', '', '   ❯ 1. Submit answers', '     2. Cancel', nav, wait];

function question(lines: string[]) {
  const result = recogniseQwenPrompt(lines, 'question', 'card', '2026-11-23T00:00:00Z');
  if (!result) throw Error('unrecognised question');
  return result;
}

describe('native Qwen dialogs', () => {
  it('preserves the visible question, alternatives and descriptions and sends its numeric selection', async () => {
    const prompt = question(nativeQuestion);
    expect(prompt.card).toMatchObject({ kind: 'question', questions: [{ question: 'Which colour?',
      options: [{ label: 'Blue', description: 'Ocean blue' }, { label: 'Green', description: 'Leaf green' }] }] });
    const write = vi.fn();
    expect(await answerQwenPrompt(prompt, { kind: 'question', answers: { 'Which colour?': 'Green' } },
      { current: () => true, screen: () => nativeQuestion, write })).toBe(true);
    expect(write.mock.calls).toEqual([['2']]);
  });

  it('refuses incomplete, unrelated and ambiguous layouts', () => {
    expect(recogniseQwenPrompt(nativeQuestion, 'permission', '', '')).toBeNull();
    for (const lines of [nativeQuestion.slice(1), nativeQuestion.slice(0, -1),
      nativeQuestion.map(line => line.replace('2. Green', '2. Blue')), [...nativeQuestion, 'Type your message']]) {
      expect(recogniseQwenPrompt(lines, 'question', '', '')).toBeNull();
    }
  });

  it('returns to an unanswered question from the native review without confirming', async () => {
    const prompt = question(review);
    expect(prompt.card).toMatchObject({ formPrompt: expect.stringContaining('Sizes: (not answered)') });
    const write = vi.fn();
    expect(await answerQwenPrompt(prompt, { kind: 'question', answers: {}, values: { answer: 'Previous question' } },
      { current: () => true, screen: () => review, write })).toBe(true);
    expect(write.mock.calls).toEqual([['\x1b[D']]);
  });

  it('sends no enter when the review closes after selecting a row', async () => {
    let lines = review;
    const write = vi.fn(() => { lines = nativeQuestion; });
    expect(await answerQwenPrompt(question(review), { kind: 'question', answers: {}, values: { answer: 'Submit answers' } },
      { current: () => true, screen: () => lines, write })).toBe(false);
    expect(write.mock.calls).toEqual([['1']]);
  });

  it('does not type an answer containing terminal control characters', async () => {
    const write = vi.fn();
    expect(await answerQwenPrompt(question(nativeQuestion), { kind: 'question', answers: { 'Which colour?': 'blue\rgreen' } },
      { current: () => true, screen: () => nativeQuestion, write })).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });
});
