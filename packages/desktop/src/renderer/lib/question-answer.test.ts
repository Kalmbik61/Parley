import { describe, expect, it } from 'vitest';
import type { FeedQuestion } from '@parley/core';
import { answerOf, type QuestionAnswerDraft } from './question-answer.js';

const question = (multiSelect: boolean): FeedQuestion => ({ question: 'Which?', header: null, options: [], multiSelect });

describe('answerOf', () => {
  it.each([
    [false, [], false, '', ''],
    [false, ['Apple', 'Pear'], false, 'hidden', 'Apple'],
    [false, ['Apple'], true, '  Mango  ', 'Mango'],
    [false, ['Apple'], true, '   ', ''],
    [true, ['Pear', 'Apple'], false, 'hidden', 'Pear, Apple'],
    [true, ['Pear', 'Apple'], true, '  Honey  ', 'Pear, Apple, Honey'],
    [true, ['Pear'], true, '   ', 'Pear'],
    [true, [], true, '  Other only  ', 'Other only'],
  ])('serializes multi=%s, picked=%j, other=%s/%j', (multi, picked, otherOn, otherText, expected) => {
    const draft: QuestionAnswerDraft = { picked: { 2: picked }, otherOn: { 2: otherOn }, otherText: { 2: otherText } };
    expect(answerOf(question(multi), 2, draft)).toBe(expected);
    expect(answerOf(question(multi), 0, draft)).toBe('');
  });
});
