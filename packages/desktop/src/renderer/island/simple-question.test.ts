/** Простой вопрос для острова: один вопрос, один выбор, до четырёх вариантов — кнопки; остальное — в Parley. */

import { describe, expect, it } from 'vitest';
import type { FeedCard } from '@parley/core';
import { simpleChoices } from './simple-question.js';

const question = (questions: unknown[]): FeedCard =>
  ({ id: 'c-1', at: '', kind: 'question', cardId: 'c-1', state: 'pending', toolUseId: null, toolName: 'AskUserQuestion', toolInput: {}, questions }) as unknown as FeedCard;
const option = (label: string) => ({ label, description: null });

describe('простой вопрос для острова', () => {
  it('один вопрос, один выбор, до четырёх вариантов — кнопки', () => {
    expect(simpleChoices(question([{ question: 'Which DB?', header: null, multiSelect: false, options: [option('Postgres'), option('SQLite')] }]))).toEqual({
      question: 'Which DB?',
      options: ['Postgres', 'SQLite'],
    });
  });

  it('мультивыбор, пять вариантов, два вопроса, не вопрос — null', () => {
    expect(simpleChoices(question([{ question: 'Q', header: null, multiSelect: true, options: [option('a')] }]))).toBeNull();
    expect(simpleChoices(question([{ question: 'Q', header: null, multiSelect: false, options: ['a', 'b', 'c', 'd', 'e'].map(option) }]))).toBeNull();
    expect(simpleChoices(question([
      { question: 'Q1', header: null, multiSelect: false, options: [option('a')] },
      { question: 'Q2', header: null, multiSelect: false, options: [option('b')] },
    ]))).toBeNull();
    expect(simpleChoices({ kind: 'plan' } as unknown as FeedCard)).toBeNull();
  });
});
