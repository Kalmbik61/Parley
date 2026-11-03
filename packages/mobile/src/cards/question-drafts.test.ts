import { describe, expect, it } from 'vitest';
import { EMPTY_QUESTION_DRAFT } from './model';
import { dropQuestionDraft, readQuestionDraft, writeQuestionDraft } from './question-drafts';

describe('question drafts survive leaving the screen', () => {
  it('keeps the picks and the step per card until dropped', () => {
    expect(readQuestionDraft('s1', 'c1')).toBe(EMPTY_QUESTION_DRAFT);
    const d = { ...EMPTY_QUESTION_DRAFT, picked: { 0: ['a'] }, step: 1 };
    writeQuestionDraft('s1', 'c1', d);
    expect(readQuestionDraft('s1', 'c1')).toBe(d);
    expect(readQuestionDraft('s1', 'c2')).toBe(EMPTY_QUESTION_DRAFT);
    expect(readQuestionDraft('s2', 'c1')).toBe(EMPTY_QUESTION_DRAFT);
    dropQuestionDraft('s1', 'c1');
    expect(readQuestionDraft('s1', 'c1')).toBe(EMPTY_QUESTION_DRAFT);
  });
});
