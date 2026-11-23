import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { codexPromptKey, recogniseCodexPrompt, type CodexPrompt } from './terminal-prompt.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'prompts');
const screen = (name: string): string[] => readFileSync(path.join(DIR, `${name}.txt`), 'utf8').split('\n');
const prompt = (name: string): CodexPrompt => {
  const found = recogniseCodexPrompt(screen(name));
  if (found === null) throw new Error(`не узнан: ${name}`);
  return found;
};

describe('recogniseCodexPrompt — одобрение команды', () => {
  it('80×24 и 120×40: команда, три варианта с цифрами 1–3, selected 0, отпечатки равны', () => {
    const small = prompt('command-approval-80x24');
    const large = prompt('command-approval-120x40');
    for (const found of [small, large]) {
      expect(found.kind).toBe('command-approval');
      if (found.kind !== 'command-approval') continue;
      expect(found.command).toBe('touch created.txt');
      expect(found.options.map((option) => option.digit)).toEqual(['1', '2', '3']);
      expect(found.options.map((option) => option.label)).toEqual([
        'Yes, proceed',
        "Yes, and don't ask again for commands that start with `touch created.txt`",
        'No, and tell Codex what to do differently',
      ]);
      expect(found.selected).toBe(0);
    }
    expect(small.fingerprint).toBe(large.fingerprint);
  });

  it('метка › на втором варианте: selected 1, отпечаток тот же', () => {
    const moved = prompt('command-approval-second-selected-80x24');
    expect(moved.selected).toBe(1);
    expect(moved.fingerprint).toBe(prompt('command-approval-80x24').fingerprint);
  });

  it('Reason переносится на вторую строку — склеивается', () => {
    const found = prompt('command-approval-reason-wrapped-80x24');
    expect(found.kind === 'command-approval' && found.command).toBe('touch c1.txt');
    expect(found.kind === 'command-approval' && found.reason).toBe('May I run `touch c1.txt` with write access? The workspace sandbox is read-only.');
  });

  it('команда в несколько строк склеивается через пробел до следующей части формы', () => {
    const lines = screen('command-approval-80x24').map((line) => (line.trim() === '$ touch created.txt' ? '  $ touch\n  created.txt' : line)).join('\n').split('\n');
    const found = recogniseCodexPrompt(lines);
    expect(found?.kind === 'command-approval' && found.command).toBe('touch created.txt');
  });

  it('узкое окно: знак прокрутки ↓ в блоке — не узнано', () => {
    expect(recogniseCodexPrompt(screen('command-approval-narrow-60x20'))).toBeNull();
  });

  it('до и после клавиши 3: до — вопрос, после — нет', () => {
    expect(prompt('command-before-3-80x24').kind).toBe('command-approval');
    expect(recogniseCodexPrompt(screen('command-after-3-80x24'))).toBeNull();
  });
});

describe('recogniseCodexPrompt — одобрение правки', () => {
  it('путь оканчивается на hello.txt, три варианта', () => {
    const found = prompt('patch-approval-80x24');
    expect(found.kind).toBe('patch-approval');
    expect(found.kind === 'patch-approval' && found.path.endsWith('hello.txt')).toBe(true);
    expect(found.options.map((option) => option.digit)).toEqual(['1', '2', '3']);
    expect(found.options[1]?.label).toBe("Yes, and don't ask again for these files");
  });

  it('путь, перенесённый посреди слова, склеивается без пробела', () => {
    const lines = [
      '  Would you like to make the following edits?',
      '',
      '  Destination:',
      '  /work/some/very/long/dir/na',
      '  me/file.txt',
      '',
      '› 1. Yes, proceed (y)',
      "  2. Yes, and don't ask again for these files (a)",
      '  3. No, and tell Codex what to do differently (esc)',
      '',
      '  Press enter to confirm or esc to cancel',
    ];
    const found = recogniseCodexPrompt(lines);
    expect(found?.kind === 'patch-approval' && found.path).toBe('/work/some/very/long/dir/name/file.txt');
  });

  it('длинный путь и другие экраны правки', () => {
    expect(prompt('patch-approval-long-path-80x24').kind).toBe('patch-approval');
    expect(prompt('patch-before-2-80x24').kind).toBe('patch-approval');
    expect(prompt('patch-before-3-80x24').kind).toBe('patch-approval');
  });
});

describe('recogniseCodexPrompt — вопрос с вариантами', () => {
  it('80×24 и 120×40: Question 1/1, варианты, None of the above последним', () => {
    for (const name of ['question-options-80x24', 'question-options-120x40']) {
      const found = prompt(name);
      expect(found.kind).toBe('question');
      if (found.kind !== 'question') continue;
      expect([found.index, found.total]).toEqual([1, 1]);
      expect(found.question).toBe('Which color do you prefer?');
      expect(found.options.map((option) => option.label)).toEqual(['Red (Recommended)', 'Green', 'Blue', 'None of the above']);
      expect(found.options.at(-1)?.label).toBe('None of the above');
    }
  });

  it('описание варианта — вторая колонка', () => {
    const found = prompt('question-options-120x40');
    expect(found.options[0]?.description).toBe('Choose red.');
    expect(found.options[3]?.description).toBe('Optionally, add details in notes (tab)');
    expect(prompt('question-options-80x24').options[0]?.description).toBe('Select red as your preferred color.');
  });

  it('Other выбран стрелкой: selected — последний вариант', () => {
    const found = prompt('question-other-selected-80x24');
    expect(found.selected).toBe(found.options.length - 1);
  });

  it('два вопроса: подсказка длиннее (навигация), второй экран — Question 2/2 с тремя вариантами', () => {
    const first = prompt('question-two-first-80x24');
    const second = prompt('question-two-second-80x24');
    expect(first.kind === 'question' && [first.index, first.total]).toEqual([1, 2]);
    expect(second.kind === 'question' && [second.index, second.total]).toEqual([2, 2]);
    expect(second.kind === 'question' && second.question).toBe('Which size do you prefer?');
    expect(second.options).toHaveLength(3);
    expect(first.fingerprint).not.toBe(second.fingerprint);
    // Цифра 4 на вопросе с тремя вариантами Codex игнорирует: тот же вопрос на экране.
    expect(prompt('question-two-after-4-ignored-80x24').fingerprint).toBe(second.fingerprint);
  });

  it('узкое окно: подпись и описание в двух колонках с переносами склеиваются', () => {
    const found = prompt('question-options-narrow-60x20');
    expect(found.kind === 'question' && found.question).toBe('Which deployment strategy should we use for the staging environment next week?');
    expect(found.options.map((option) => option.label)).toEqual([
      'Blue-green deployment (Recommended)',
      'Rolling update',
      'Canary release',
      'None of the above',
    ]);
    expect(found.options[0]?.description).toBe('Blue-green deployment with a gradual traffic shift');
    expect(found.options[3]?.description).toBe('Optionally, add details in notes');
  });

  it('до цифры 4 и после: до — вопрос, после — нет', () => {
    expect(prompt('question-none-before-80x24').kind).toBe('question');
    expect(recogniseCodexPrompt(screen('question-none-after-80x24'))).toBeNull();
  });
});

describe('recogniseCodexPrompt — не вопрос', () => {
  it.each([
    'idle-80x24',
    'command-approved-120x40',
    'command-after-2-80x24',
    'command-after-3-80x24',
    'command-after-3-typed-80x24',
    'patch-after-esc-80x24',
    'patch-after-1-80x24',
    'patch-after-2-80x24',
    'patch-after-3-80x24',
    'patch-after-3-typed-80x24',
    'question-answered-80x24',
    'question-answered-by-digit-120x40',
    'question-two-answered-80x24',
    'question-notes-open-80x24',
    'question-notes-typed-80x24',
    'hooks-trust-80x24',
    'hooks-trust-120x40',
    'trust-folder-80x24',
    'auto-review-no-prompt-80x24',
    'plan-mode-only-note-80x24',
  ])('%s → null', (name) => {
    expect(recogniseCodexPrompt(screen(name))).toBeNull();
  });

  it('пустой экран и пустой список', () => {
    expect(recogniseCodexPrompt([])).toBeNull();
    expect(recogniseCodexPrompt(['', '', ''])).toBeNull();
  });

  it('одобрение без строки-подсказки → null', () => {
    const lines = screen('command-approval-80x24').filter((line) => !line.includes('Press enter to confirm'));
    expect(recogniseCodexPrompt(lines)).toBeNull();
  });

  it('варианты 1. и 3. без 2. → null', () => {
    const lines = screen('command-approval-80x24').filter((line) => !/^\s*2\. /.test(line) && !/^\s+\(p\)/.test(line));
    expect(recogniseCodexPrompt(lines)).toBeNull();
  });

  it('четыре варианта у одобрения → null (форма другая)', () => {
    const lines = screen('command-approval-80x24');
    const at = lines.findIndex((line) => line.includes('3. No'));
    const extended = [...lines.slice(0, at + 1), '  4. Something else', ...lines.slice(at + 1)];
    expect(recogniseCodexPrompt(extended)).toBeNull();
  });

  it('у вопроса нет строки-подсказки → null', () => {
    const lines = screen('question-options-80x24').filter((line) => !line.includes('tab to add notes'));
    expect(recogniseCodexPrompt(lines)).toBeNull();
  });

  it('знак прокрутки в вопросе → null', () => {
    const lines = screen('question-options-80x24');
    const at = lines.findIndex((line) => line.includes('3. Blue'));
    expect(recogniseCodexPrompt([...lines.slice(0, at + 1), '↓', ...lines.slice(at + 1)])).toBeNull();
  });

  it('в отпечаток не входят ни метка ›, ни пустые строки (перерисовка того же вопроса)', () => {
    const lines = screen('command-approval-80x24');
    const redrawn = ['', '', ...lines];
    expect(recogniseCodexPrompt(redrawn)?.fingerprint).toBe(prompt('command-approval-80x24').fingerprint);
  });
});

describe('codexPromptKey', () => {
  const approval = prompt('command-approval-80x24');
  const patch = prompt('patch-approval-80x24');
  const question = prompt('question-options-80x24');
  const ask = (answer: string) => ({ kind: 'question' as const, answers: { 'Which color do you prefer?': answer } });

  it('одобрение: allow → 1, allow+always → 2, deny → 3 (и для правки)', () => {
    for (const found of [approval, patch]) {
      expect(codexPromptKey(found, { kind: 'permission', behavior: 'allow' })).toBe('1');
      expect(codexPromptKey(found, { kind: 'permission', behavior: 'allow', always: true })).toBe('2');
      expect(codexPromptKey(found, { kind: 'permission', behavior: 'deny' })).toBe('3');
      expect(codexPromptKey(found, { kind: 'permission', behavior: 'deny', message: 'use another way' })).toBe('3');
    }
  });

  it('вопрос: ответ, равный подписи варианта, → его цифра', () => {
    expect(codexPromptKey(question, ask('Red (Recommended)'))).toBe('1');
    expect(codexPromptKey(question, ask('Green'))).toBe('2');
    expect(codexPromptKey(question, ask('Blue'))).toBe('3');
  });

  it('вопрос: свой ответ и «None of the above» одним нажатием не выражаются → null', () => {
    expect(codexPromptKey(question, ask('purple'))).toBeNull();
    expect(codexPromptKey(question, ask('None of the above'))).toBeNull();
    expect(codexPromptKey(question, { kind: 'question', answers: {} })).toBeNull();
  });

  it('решение не того вида → null', () => {
    expect(codexPromptKey(approval, { kind: 'question', answers: { x: 'y' } })).toBeNull();
    expect(codexPromptKey(approval, { kind: 'plan', choice: 'manual' })).toBeNull();
    expect(codexPromptKey(question, { kind: 'permission', behavior: 'allow' })).toBeNull();
  });
});
