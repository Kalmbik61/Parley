/** Сводка вопроса для уведомления «нужен ты»: что просят, какая карточка последняя ждущая, можно ли ответить в окне. */

import { describe, expect, it } from 'vitest';
import type { FeedCard, FeedItem, FeedPermissionCard, FeedPlanCard, FeedQuestionCard } from '@parley/core';
import { askSummary, pendingAskOf, pendingCards } from './ask-summary.js';

const AT = '2026-01-01T00:00:00.000Z';

function permission(id: string, toolName: string, toolInput: Record<string, unknown>, state: FeedPermissionCard['state'] = 'pending'): FeedPermissionCard {
  return { kind: 'permission', id, at: AT, cardId: id, state, toolUseId: null, toolName, toolInput, suggestions: [], notified: false };
}

function question(id: string, text: string, state: FeedQuestionCard['state'] = 'pending'): FeedQuestionCard {
  return {
    kind: 'question',
    id,
    at: AT,
    cardId: id,
    state,
    toolUseId: null,
    toolName: 'AskUserQuestion',
    toolInput: {},
    questions: [{ question: text, header: null, options: [], multiSelect: false }],
  };
}

function plan(id: string, state: FeedPlanCard['state'] = 'pending'): FeedPlanCard {
  return { kind: 'plan', id, at: AT, cardId: id, state, toolUseId: null, toolName: 'ExitPlanMode', toolInput: {}, plan: '# Plan', planFilePath: null };
}

const PROJECT = '/Users/me/my_project';

describe('askSummary', () => {
  it('Bash с многострочной командой — «Run:» и первая непустая строка', () => {
    expect(askSummary(permission('c1', 'Bash', { command: '\nnpm test\nnpm run build' }), PROJECT)).toBe('Run: npm test');
  });

  it('Codex присылает команду массивом — склейка через пробел, затем первая строка', () => {
    expect(askSummary(permission('c1', 'shell', { command: ['git', 'status', '--short'] }), PROJECT)).toBe('Run: git status --short');
  });

  it('Edit с абсолютным путём внутри проекта — путь относительный', () => {
    expect(askSummary(permission('c1', 'Edit', { file_path: `${PROJECT}/src/app.ts` }), PROJECT)).toBe('Edit: src/app.ts');
  });

  it('проект с хвостовым слешем — путь всё равно относительный', () => {
    expect(askSummary(permission('c1', 'Write', { file_path: `${PROJECT}/src/app.ts` }), `${PROJECT}/`)).toBe('Write: src/app.ts');
  });

  it('путь вне проекта и путь-сосед с общим префиксом — как есть', () => {
    expect(askSummary(permission('c1', 'Read', { file_path: '/etc/hosts' }), PROJECT)).toBe('Read: /etc/hosts');
    expect(askSummary(permission('c1', 'Read', { path: `${PROJECT}_other/a.ts` }), PROJECT)).toBe(`Read: ${PROJECT}_other/a.ts`);
  });

  it('NotebookEdit берёт notebook_path', () => {
    expect(askSummary(permission('c1', 'NotebookEdit', { notebook_path: `${PROJECT}/a.ipynb` }), PROJECT)).toBe('NotebookEdit: a.ipynb');
  });

  it('WebFetch — «Fetch:» и адрес', () => {
    expect(askSummary(permission('c1', 'WebFetch', { url: 'https://example.com/docs' }), PROJECT)).toBe('Fetch: https://example.com/docs');
  });

  it('неизвестный инструмент без знакомых полей — имя инструмента', () => {
    expect(askSummary(permission('c1', 'mcp__x__do', { foo: 1 }), PROJECT)).toBe('mcp__x__do');
  });

  it('вопрос — «Question:» и первая строка первого вопроса', () => {
    expect(askSummary(question('c1', 'Which API?\ndetails'), PROJECT)).toBe('Question: Which API?');
  });

  it('план — «Plan ready for review»', () => {
    expect(askSummary(plan('c1'), PROJECT)).toBe('Plan ready for review');
  });
});

describe('pendingAskOf', () => {
  it('берёт последнюю ждущую карточку: cardId — её id', () => {
    const items: FeedItem[] = [permission('c1', 'Bash', { command: 'ls' }), question('c2', 'Which?')];
    expect(pendingAskOf({ items }, PROJECT)).toEqual({ cardId: 'c2', summary: 'Question: Which?', inWindow: true });
  });

  it('карточки не в состоянии pending пропускает', () => {
    const items: FeedItem[] = [permission('c1', 'Bash', { command: 'ls' }), permission('c2', 'Bash', { command: 'rm x' }, 'allowed'), plan('c3', 'answered')];
    expect(pendingAskOf({ items }, PROJECT)?.cardId).toBe('c1');
  });

  it('обычные элементы ленты не считаются карточкой', () => {
    const items: FeedItem[] = [{ kind: 'prompt', id: 'p1', at: AT, text: 'hi' } as unknown as FeedCard];
    expect(pendingAskOf({ items }, PROJECT)).toBeNull();
  });

  it('ждущей карточки нет — null', () => {
    expect(pendingAskOf({ items: [] }, PROJECT)).toBeNull();
    expect(pendingAskOf({ items: [plan('c1', 'answered')] }, PROJECT)).toBeNull();
  });

  it("decisions: 'terminal' — inWindow false; 'window', null и отсутствие поля — true", () => {
    const items: FeedItem[] = [plan('c1')];
    expect(pendingAskOf({ items, decisions: 'terminal' }, PROJECT)?.inWindow).toBe(false);
    expect(pendingAskOf({ items, decisions: 'window' }, PROJECT)?.inWindow).toBe(true);
    expect(pendingAskOf({ items, decisions: null }, PROJECT)?.inWindow).toBe(true);
    expect(pendingAskOf({ items }, PROJECT)?.inWindow).toBe(true);
  });
});

describe('pendingCards', () => {
  it('все ждущие карточки по порядку ленты, ответившие не в счёт', () => {
    const items: FeedItem[] = [
      permission('c-1', 'Bash', { command: 'ls' }),
      permission('c-2', 'Bash', { command: 'rm x' }, 'allowed'),
      question('c-3', 'Which?'),
    ];
    expect(pendingCards(items).map((card) => card.cardId)).toEqual(['c-1', 'c-3']);
  });
});
