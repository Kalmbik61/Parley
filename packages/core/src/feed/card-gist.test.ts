import { describe, expect, it } from 'vitest';
import { cardDetail, cardGist, pendingCards } from './card-gist.js';
import type { FeedCard, FeedPermissionCard, FeedPlanCard, FeedQuestionCard } from './types.js';

function permission(toolName: string, toolInput: Record<string, unknown>, state: FeedCard['state'] = 'pending'): FeedPermissionCard {
  return {
    kind: 'permission', id: 'c1', cardId: 'c1', at: '2026-10-19T10:00:00Z', state,
    toolUseId: null, toolName, toolInput, suggestions: [], notified: false,
  };
}

function question(text: string, labels: string[]): FeedQuestionCard {
  return {
    kind: 'question', id: 'q1', cardId: 'q1', at: '2026-10-19T10:00:00Z', state: 'pending',
    toolUseId: null, toolName: 'AskUserQuestion', toolInput: {},
    questions: [{ question: text, header: null, options: labels.map((label) => ({ label, description: null })), multiSelect: false }],
  };
}

function plan(text: string): FeedPlanCard {
  return {
    kind: 'plan', id: 'p1', cardId: 'p1', at: '2026-10-19T10:00:00Z', state: 'pending',
    toolUseId: null, toolName: 'ExitPlanMode', toolInput: {}, plan: text, planFilePath: null,
  };
}

describe('cardGist', () => {
  it('команда Claude — первая непустая строка', () => {
    expect(cardGist(permission('Bash', { command: 'rm -rf dist\n# second' }), '/p')).toEqual({ kind: 'run', command: 'rm -rf dist' });
  });

  it('argv Codex склеен пробелом', () => {
    expect(cardGist(permission('Bash', { command: ['git', 'status'] }), '/p')).toEqual({ kind: 'run', command: 'git status' });
  });

  it('путь внутри проекта — относительно него', () => {
    expect(cardGist(permission('Edit', { file_path: '/p/src/a.ts' }), '/p')).toEqual({ kind: 'tool', tool: 'Edit', path: 'src/a.ts' });
  });

  it('WebFetch с url — fetch', () => {
    expect(cardGist(permission('WebFetch', { url: 'https://example.com' }), '/p')).toEqual({ kind: 'fetch', url: 'https://example.com' });
  });

  it('инструмент без путей — path: null', () => {
    expect(cardGist(permission('Read', {}), '/p')).toEqual({ kind: 'tool', tool: 'Read', path: null });
  });

  it('вопрос — первая строка первого вопроса', () => {
    expect(cardGist(question('Which db?\nsecond line', ['pg']), '/p')).toEqual({ kind: 'question', text: 'Which db?' });
  });

  it('план — plan', () => {
    expect(cardGist(plan('step 1'), '/p')).toEqual({ kind: 'plan' });
  });
});

describe('cardDetail', () => {
  it('разрешение с командой — команда целиком', () => {
    expect(cardDetail(permission('Bash', { command: 'rm -rf dist\n# second' }))).toBe('rm -rf dist\n# second');
  });

  it('правка — old_string и new_string через стрелку', () => {
    expect(cardDetail(permission('Edit', { file_path: '/p/a.ts', old_string: 'a', new_string: 'b' }))).toBe('a\n→\nb');
  });

  it('вопрос — «Q:» и варианты по строке', () => {
    expect(cardDetail(question('Which db?', ['pg', 'sqlite']))).toBe('Q: Which db?\n- pg\n- sqlite');
  });

  it('несколько вопросов — блоки «Q1:», «Q2:» через пустую строку', () => {
    const first = question('Which db?', ['pg', 'sqlite']);
    const second = question('Which tags?', ['a']);
    const both: FeedQuestionCard = { ...first, questions: [...first.questions, ...second.questions] };
    expect(cardDetail(both)).toBe('Q1: Which db?\n- pg\n- sqlite\n\nQ2: Which tags?\n- a');
    expect(cardDetail(both, 10)).toBe('Q1: Which …');
  });

  it('Write — содержимое файла, NotebookEdit — новый исходник ячейки', () => {
    expect(cardDetail(permission('Write', { file_path: '/p/a.ts', content: 'const a = 1;' }))).toBe('const a = 1;');
    expect(cardDetail(permission('NotebookEdit', { notebook_path: '/p/n.ipynb', new_source: 'print(1)' }))).toBe('print(1)');
  });

  it('MultiEdit — каждая правка «old → new», правки через «---»', () => {
    const detail = cardDetail(permission('MultiEdit', { file_path: '/p/a.ts', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] }));
    expect(detail).toBe('a\n→\nb\n---\nc\n→\nd');
  });

  it('план длиннее 1500 знаков обрезан с «…»', () => {
    const detail = cardDetail(plan('x'.repeat(2000)));
    expect(detail).toBe(`${'x'.repeat(1500)}…`);
  });

  it('длиннее max — обрезано и заканчивается «…»', () => {
    const detail = cardDetail(permission('Bash', { command: 'abcdefghij' }), 4);
    expect(detail).toBe('abcd…');
  });

  it('нечего показать — null', () => {
    expect(cardDetail(permission('Read', { file_path: '/p/a.ts' }))).toBeNull();
  });
});

describe('pendingCards', () => {
  it('оставляет только ждущие ответа, по порядку', () => {
    const waiting = permission('Bash', { command: 'ls' });
    const items = [permission('Bash', { command: 'pwd' }, 'allowed'), waiting, plan('p')];
    expect(pendingCards(items)).toEqual([waiting, items[2]]);
  });
});
