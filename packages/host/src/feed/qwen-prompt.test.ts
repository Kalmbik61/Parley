import { describe, expect, it, vi } from 'vitest';
import { answerQwenPrompt, recogniseQwenPrompt } from './qwen-prompt.js';

const wait = '⠏ Waiting for user confirmation...';
const nav = ' ↑/↓: Navigate | ←/→: Switch tabs | Enter: Select | Esc: Cancel';
const header = '? AskUserQuestion Ask user 2 questions ←';
const nativeQuestion = [header, ' ▸ Colour   Sizes  Submit', '', ' Which colour?', '',
  '   ❯ 1. Blue', '        Ocean blue', '     2. Green', '        Leaf green', '     3. Type something...', nav, wait];
const feedback = ['', '\u25cf\ufe0e How is Qwen doing this session? (optional)', '', '1: Good 2: Bad 3: Fine 0: Dismiss'];
const russianFeedback = ['', '\u25cf Как дела у Qwen в этой сессии? (необязательно)', '', '1: Хорошо 2: Плохо 3: Нормально 0: Отклонить'];
const review = [header, ' Colour ✓  Sizes  ▸ Submit', '', ' Your answers:', '   Colour: Green', '   Sizes: (not answered)',
  '', ' Ready to submit your answers?', '', '   ❯ 1. Submit answers', '     2. Cancel', nav, wait];

function question(lines: string[]) {
  const result = recogniseQwenPrompt(lines, 'question', 'card', '2026-11-23T00:00:00Z');
  if (!result) throw Error('unrecognised question');
  return result;
}

function withScrollbar(lines: string[], widths = lines.map(line => line.length), glyphs = ['│', '█']): string[] {
  return [...lines.slice(0, -1).map((line, i) => line + ' '.repeat(96 - widths[i]!) + glyphs[i % glyphs.length]), '', lines.at(-1)!];
}

describe('native Qwen dialogs', () => {
  it.each([['track', ['│']], ['thumb', ['█']], ['mixed', ['│', '█']]] as const)('recognises the first viewport with an aligned %s scrollbar', (_name, glyphs) => {
    const plain = question(nativeQuestion);
    const indented = nativeQuestion.map((line, i) => i === 0 ? '  ' + line : line);
    const initial = ['Earlier output'.padEnd(96) + '│', ...withScrollbar(indented, undefined, [...glyphs])];
    const parsed = question(initial);
    expect(parsed.card).toEqual(plain.card);
    expect(parsed.rows).toEqual(plain.rows);
    expect(parsed.fingerprint).toBe(plain.fingerprint);
  });

  it('preserves wide and combining text and content ending in scrollbar glyphs', () => {
    const lines = nativeQuestion.map(line => line.replace('Blue', '蓝色 │').replace('Ocean blue', 'Cafe\u0301 █').replace('Green', 'Green █'));
    const widths = lines.map((line, i) => line.length + (i === 5 ? 2 : i === 6 ? -1 : 0));
    const initial = question(withScrollbar(lines, widths));
    const faded = question(lines);
    expect(initial.card).toEqual(faded.card);
    expect(initial.rows).toEqual(faded.rows);
    expect(initial.fingerprint).toBe(faded.fingerprint);
    expect(initial.rows[0]).toMatchObject({ label: '蓝色 │', description: 'Cafe\u0301 █' });
  });

  it('answers while the scrollbar remains after dismissing feedback', async () => {
    const bar = withScrollbar(nativeQuestion);
    let lines = [...bar, ...feedback];
    const write = vi.fn((keys: string) => { if (keys === '0') lines = bar; });
    expect(await answerQwenPrompt(question(lines), { kind: 'question', answers: { 'Which colour?': 'Green' } },
      { current: () => true, screen: () => lines, write })).toBe(true);
    expect(write.mock.calls).toEqual([['0'], ['2']]);
  });

  it('rejects misaligned or incomplete scrollbars and malformed menus', () => {
    const initial = withScrollbar(nativeQuestion);
    for (const lines of [initial.slice(1), initial.slice(0, -1),
      initial.map((line, i) => i === 5 ? line.slice(0, -2) + line.at(-1) : line),
      initial.map((line, i) => i === 6 ? line.slice(0, -1) : line),
      initial.map(line => line.replace('2. Green', '4. Green')),
      initial.map(line => line.replace('↑/↓:', 'Unknown help:')),
      initial.map(line => line.replace(/[│█]$/u, '┃'))]) {
      expect(recogniseQwenPrompt(lines, 'question', '', '')).toBeNull();
    }
  });

  it('recognises emoji labels without changing their content or question identity', () => {
    const lines = nativeQuestion.map(line => line.replace('Blue', 'Blue 🙂'));
    expect(question(withScrollbar(lines)).card).toEqual(question(lines).card);
    expect(question(withScrollbar(lines)).fingerprint).toBe(question(lines).fingerprint);
  });

  it('recognises native Russian punctuation and a decorated blank after the help row', () => {
    const lines = nativeQuestion.map(line => line.replace('Which colour?', 'Какой цвет — «синий» или “зелёный”…?'));
    const bar = withScrollbar([...lines.slice(0, -1), '', lines.at(-1)!]);
    expect(question(bar).card).toEqual(question(lines).card);
    expect(question(bar).rows).toEqual(question(lines).rows);
    expect(question(bar).fingerprint).toBe(question(lines).fingerprint);
  });

  it.each([['English', feedback], ['Russian', russianFeedback]] as const)('recognises the complete %s feedback suffix without changing the question identity', (_language, suffix) => {
    const plain = question(nativeQuestion);
    const withFeedback = question([...nativeQuestion, ...suffix]);
    expect(withFeedback.fingerprint).toBe(plain.fingerprint);
    expect(withFeedback.card).toEqual(plain.card);
    expect(withFeedback.rows).toEqual(plain.rows);
    expect(withFeedback.feedback).toBe(true);
  });

  it('rejects incomplete, mixed and unknown feedback suffixes and feedback without a question', () => {
    for (const suffix of [feedback.slice(0, -1), feedback.slice(1, 3),
      feedback.map(line => line.replace('0: Dismiss', '0: Skip')),
      feedback.map(line => line.replace('\u25cf\ufe0e ', '')),
      [feedback[0]!, feedback[1]!, '', russianFeedback[3]!],
      feedback.filter((_, i) => i !== 2), [...feedback, 'Unknown overlay']]) {
      expect(recogniseQwenPrompt([...nativeQuestion, ...suffix], 'question', '', '')).toBeNull();
    }
    expect(recogniseQwenPrompt(feedback, 'question', '', '')).toBeNull();
    expect(recogniseQwenPrompt([...nativeQuestion.slice(1), ...feedback], 'question', '', '')).toBeNull();
    expect(recogniseQwenPrompt([...nativeQuestion.slice(0, -1), ...feedback], 'question', '', '')).toBeNull();
  });

  it('waits for the unchanged question without feedback before sending a numeric answer', async () => {
    const initial = [...nativeQuestion, ...feedback];
    let lines = initial;
    const write = vi.fn((keys: string) => {
      if (keys === '0') setTimeout(() => { lines = nativeQuestion; }, 10);
      else expect(lines).toBe(nativeQuestion);
    });
    expect(await answerQwenPrompt(question(initial), { kind: 'question', answers: { 'Which colour?': 'Green' } },
      { current: () => true, screen: () => lines, write })).toBe(true);
    expect(write.mock.calls).toEqual([['0'], ['2']]);
  });

  it('dismisses feedback before opening and filling the optional custom editor', async () => {
    const initial = [...nativeQuestion, ...feedback];
    let lines = initial;
    const editor = nativeQuestion.map(line => line.replace('❯ 1.', '  1.').replace('     3. Type something...', '   ❯ 3. > Type something...'));
    const write = vi.fn((keys: string) => {
      if (keys === '0') lines = nativeQuestion;
      if (keys === '3') lines = editor;
      if (keys === 'Orange') lines = editor.map(line => line.replace('> Type something...', '> Orange'));
    });
    expect(await answerQwenPrompt(question(initial), { kind: 'question', answers: { 'Which colour?': 'Orange' } },
      { current: () => true, screen: () => lines, write })).toBe(true);
    expect(write.mock.calls).toEqual([['0'], ['3'], ['Orange'], ['\r']]);
  });

  it.each([{}, { 'Which colour?': '' }, { 'Which colour?': 'bad\ranswer' }, { 'Which colour?': ' spaced ' },
    { 'Which colour?': 'x'.repeat(16 * 1024 + 1) }])('never dismisses feedback for a missing or invalid answer', async answers => {
    const lines = [...nativeQuestion, ...feedback];
    const write = vi.fn();
    expect(await answerQwenPrompt(question(lines), { kind: 'question', answers },
      { current: () => true, screen: () => lines, write })).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it.each(['editor', 'question', 'redraw', 'process', 'overlay', 'selection'])('stops after dismissal if the %s changes', async change => {
    const initial = [...nativeQuestion, ...feedback];
    let lines = initial;
    let current = true;
    const write = vi.fn(() => {
      if (change === 'editor') lines = nativeQuestion.map(line => line.replace('❯ 1.', '  1.').replace('     3. Type something...', '   ❯ 3. > Type something...'));
      if (change === 'question') lines = nativeQuestion.map(line => line.replace('Which colour?', 'Which shape?'));
      if (change === 'redraw') lines = nativeQuestion.slice(1);
      if (change === 'process') current = false;
      if (change === 'overlay') lines = [...nativeQuestion, 'Unknown overlay'];
      if (change === 'selection') lines = nativeQuestion.map(line => line.replace('❯ 1.', '  1.').replace('     2.', '   ❯ 2.'));
    });
    expect(await answerQwenPrompt(question(initial), { kind: 'question', answers: { 'Which colour?': 'Green' } },
      { current: () => current, screen: () => lines, write })).toBe(false);
    expect(write.mock.calls).toEqual([['0']]);
  });

  it('does not dismiss feedback when the operator already opened the custom editor', async () => {
    const initial = [...nativeQuestion, ...feedback];
    const editor = initial.map(line => line.replace('❯ 1.', '  1.').replace('     3. Type something...', '   ❯ 3. > Type something...'));
    const write = vi.fn();
    expect(await answerQwenPrompt(question(initial), { kind: 'question', answers: { 'Which colour?': 'Green' } },
      { current: () => true, screen: () => editor, write })).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it('sends no answer when feedback never redraws after dismissal', async () => {
    const lines = [...nativeQuestion, ...feedback];
    const write = vi.fn();
    expect(await answerQwenPrompt(question(lines), { kind: 'question', answers: { 'Which colour?': 'Green' } },
      { current: () => true, screen: () => lines, write })).toBe(false);
    expect(write.mock.calls).toEqual([['0']]);
  });

  it('uses the normal answer path if feedback disappeared before the click', async () => {
    const write = vi.fn();
    expect(await answerQwenPrompt(question([...nativeQuestion, ...feedback]), { kind: 'question', answers: { 'Which colour?': 'Green' } },
      { current: () => true, screen: () => nativeQuestion, write })).toBe(true);
    expect(write.mock.calls).toEqual([['2']]);
  });

  it('refuses invalid multiselect choices and custom input before dismissing feedback', async () => {
    const lines = [...nativeQuestion.map(line => line.replace('1. Blue', '[ ] 1. Blue').replace('2. Green', '[ ] 2. Green')), ...feedback];
    for (const values of [{ choices: ['Unknown'] }, { choices: ['Blue'], other: 'bad\nanswer' }, { choices: [] }]) {
      const write = vi.fn();
      expect(await answerQwenPrompt(question(lines), { kind: 'question', answers: {}, values },
        { current: () => true, screen: () => lines, write })).toBe(false);
      expect(write).not.toHaveBeenCalled();
    }
  });

  it('does not confirm a custom answer if feedback reappears over the editor', async () => {
    let lines = nativeQuestion;
    const editor = nativeQuestion.map(line => line.replace('❯ 1.', '  1.').replace('     3. Type something...', '   ❯ 3. > Type something...'));
    const write = vi.fn((keys: string) => {
      if (keys === '3') lines = editor;
      if (keys === 'Orange') lines = [...editor.map(line => line.replace('> Type something...', '> Orange')), ...feedback];
    });
    expect(await answerQwenPrompt(question(nativeQuestion), { kind: 'question', answers: { 'Which colour?': 'Orange' } },
      { current: () => true, screen: () => lines, write })).toBe(false);
    expect(write.mock.calls).toEqual([['3'], ['Orange']]);
  });

  it('does not take over an editor opened just before starting a custom answer', async () => {
    const editor = nativeQuestion.map(line => line.replace('❯ 1.', '  1.').replace('     3. Type something...', '   ❯ 3. > Type something...'));
    let reads = 0;
    const write = vi.fn();
    expect(await answerQwenPrompt(question(nativeQuestion), { kind: 'question', answers: { 'Which colour?': 'Orange' } },
      { current: () => true, screen: () => ++reads === 1 ? nativeQuestion : editor, write })).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

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

  // The chat/island wire format (`answerOf`) joins picked labels and the «Other» text with ', '
  // and sends no `values`; the host must restore the picks from the joined string.
  describe('joined multiselect answers', () => {
    const multiHeader = '? AskUserQuestion Ask user 1 question ←';
    const multiNav = ' ↑/↓: Navigate | Space: Toggle | Enter: Confirm | Esc: Cancel';
    function multiFixture(labels: readonly string[]) {
      let selected = 1;
      const checked = new Set<number>();
      let editor: string | null = null;
      const customNumber = labels.length + 1;
      const screen = (): string[] => [
        multiHeader, ' Toppings', '', ' Which toppings?', '',
        ...labels.map((label, i) => `${selected === i + 1 ? '   ❯ ' : '     '}${checked.has(i + 1) ? '[✓]' : '[ ]'} ${i + 1}. ${label}`),
        selected === customNumber ? `   ❯ [ ] ${customNumber}. > ${editor || 'Type something...'}` : `     [ ] ${customNumber}. Type something...`,
        multiNav, wait,
      ];
      const write = vi.fn((keys: string) => {
        if (selected === customNumber && keys !== '\r') { editor = (editor ?? '') + keys; return; }
        if (/^[1-9]$/.test(keys)) {
          const n = Number(keys);
          selected = n;
          editor = n === customNumber ? '' : null;
        } else if (keys === ' ' && selected <= labels.length) {
          if (checked.has(selected)) checked.delete(selected);
          else checked.add(selected);
        }
      });
      return { screen, write };
    }
    const decide = (answer: string) => ({ kind: 'question' as const, answers: { 'Which toppings?': answer } });

    it('toggles every picked label and confirms with Enter', async () => {
      const { screen, write } = multiFixture(['Nuts', 'Cream', 'Honey']);
      const parsed = recogniseQwenPrompt(screen(), 'question', 'card', '');
      expect(parsed?.card.questions[0]).toMatchObject({ multiSelect: true, options: [{ label: 'Nuts' }, { label: 'Cream' }, { label: 'Honey' }] });
      expect(await answerQwenPrompt(parsed!, decide('Nuts, Honey'), { current: () => true, screen, write })).toBe(true);
      expect(write.mock.calls).toEqual([['1'], [' '], ['3'], [' '], ['\r']]);
    });

    it('keeps a single picked label working', async () => {
      const { screen, write } = multiFixture(['Nuts', 'Cream', 'Honey']);
      expect(await answerQwenPrompt(recogniseQwenPrompt(screen(), 'question', 'card', '')!, decide('Cream'),
        { current: () => true, screen, write })).toBe(true);
      expect(write.mock.calls).toEqual([['2'], [' '], ['\r']]);
    });

    it('types the unmatched remainder as the Other text', async () => {
      const { screen, write } = multiFixture(['Nuts', 'Cream', 'Honey']);
      expect(await answerQwenPrompt(recogniseQwenPrompt(screen(), 'question', 'card', '')!, decide('Nuts, sweet crunch'),
        { current: () => true, screen, write })).toBe(true);
      expect(write.mock.calls).toEqual([['1'], [' '], ['4'], ['sweet crunch'], ['\r']]);
    });

    it('types an answer that matches no label as the Other text', async () => {
      const { screen, write } = multiFixture(['Nuts', 'Cream', 'Honey']);
      expect(await answerQwenPrompt(recogniseQwenPrompt(screen(), 'question', 'card', '')!, decide('just text'),
        { current: () => true, screen, write })).toBe(true);
      expect(write.mock.calls).toEqual([['4'], ['just text'], ['\r']]);
    });

    it('does not split a label that contains the join separator', async () => {
      const { screen, write } = multiFixture(['Salt, pepper', 'Nuts']);
      expect(await answerQwenPrompt(recogniseQwenPrompt(screen(), 'question', 'card', '')!, decide('Salt, pepper, Nuts'),
        { current: () => true, screen, write })).toBe(true);
      expect(write.mock.calls).toEqual([['1'], [' '], ['2'], [' '], ['\r']]);
    });

    it('prefers explicit values over the joined answer', async () => {
      const { screen, write } = multiFixture(['Nuts', 'Cream', 'Honey']);
      const decision = { kind: 'question' as const, answers: { 'Which toppings?': 'Nuts, Honey' }, values: { choices: ['Cream'] } };
      expect(await answerQwenPrompt(recogniseQwenPrompt(screen(), 'question', 'card', '')!, decision,
        { current: () => true, screen, write })).toBe(true);
      expect(write.mock.calls).toEqual([['2'], [' '], ['\r']]);
    });
  });

  describe('scoped always-allow permission rows', () => {
    // Live qwen 0.27.2 shell confirmation (auto mode asks the same dialog when the classifier blocks).
    const shellPermission = [
      '? Shell touch /tmp/probe/file (Create an empty file as requested.) ←',
      '   touch /tmp/probe/file',
      " Allow execution of: 'touch'?",
      ' › 1. Yes, allow once',
      "   2. Always allow run 'touch *' commands in this project",
      "   3. Always allow run 'touch *' commands for this user",
      '   4. No, suggest changes (esc)',
      wait,
    ];
    const parse = (lines: readonly string[]) => recogniseQwenPrompt(lines, 'permission', 'card', '');

    it('recognises the project and user scoped rows as allow_always', () => {
      expect(parse(shellPermission)?.card).toMatchObject({
        kind: 'permission',
        permissionOptions: [
          { optionId: '1', kind: 'allow_once' },
          { optionId: '2', kind: 'allow_always', name: "Always allow run 'touch *' commands in this project" },
          { optionId: '3', kind: 'allow_always', name: "Always allow run 'touch *' commands for this user" },
          { optionId: '4', kind: 'reject_once' },
        ],
      });
    });

    it.each([
      ['project', "Always allow run 'touch *' commands in this project"],
      ['user', "Always allow run 'touch *' commands for this user"],
      ['plain project', 'Always allow in this project'],
      ['plain user', 'Always allow for this user'],
      ['russian project', "Всегда разрешать run 'touch *' commands в этом проекте"],
      ['russian user', "Всегда разрешать run 'touch *' commands для этого пользователя"],
      ['russian plain project', 'Всегда разрешать в этом проекте'],
      ['russian plain user', 'Всегда разрешать для этого пользователя'],
    ])('answers the %s scoped row with its number', async (_name, label) => {
      const lines = shellPermission.map((line, i) => (i === 4 ? `   2. ${label}` : line));
      const prompt = parse(lines)!;
      const option = prompt.card.kind === 'permission' ? prompt.card.permissionOptions?.find(entry => entry.name === label) : undefined;
      expect(option?.kind).toBe('allow_always');
      const write = vi.fn();
      expect(await answerQwenPrompt(prompt, { kind: 'permission', behavior: 'allow', optionId: option!.optionId },
        { current: () => true, screen: () => lines, write })).toBe(true);
      expect(write.mock.calls).toEqual([[option!.optionId]]);
    });

    it('still rejects an unknown always-allow wording', () => {
      const lines = shellPermission.map(line => line.replace("Always allow run 'touch *' commands in this project", 'Always allow everything everywhere'));
      expect(parse(lines)).toBeNull();
    });
  });
});
