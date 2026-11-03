import { describe, expect, it, vi } from 'vitest';
import { EMPTY_QUESTION_DRAFT } from './model';
import { clearQuestionDrafts, draftKey, dropQuestionDraft, pruneQuestionDrafts, readQuestionDraft, seedQuestionDraft, subscribeQuestionDrafts, updateQuestionDraft } from './question-drafts';

describe('question drafts survive leaving the screen', () => {
  const k = draftKey('p\u0000w\u0000s1', 'c1');
  it('keeps the picks and the step per card until dropped', () => {
    expect(readQuestionDraft(k)).toBe(EMPTY_QUESTION_DRAFT);
    updateQuestionDraft(k, (x) => ({ ...x, picked: { 0: ['a'] }, step: 1 }));
    expect(readQuestionDraft(k)).toMatchObject({ picked: { 0: ['a'] }, step: 1 });
    expect(readQuestionDraft(draftKey('p\u0000w\u0000s1', 'c2'))).toBe(EMPTY_QUESTION_DRAFT);
    expect(readQuestionDraft(draftKey('p\u0000w\u0000s2', 'c1'))).toBe(EMPTY_QUESTION_DRAFT);
    dropQuestionDraft(k);
    expect(readQuestionDraft(k)).toBe(EMPTY_QUESTION_DRAFT);
  });
  it('updates are functional against the stored draft, and subscribers see them', () => {
    const seen = vi.fn();
    const off = subscribeQuestionDrafts(seen);
    updateQuestionDraft(k, (x) => ({ ...x, picked: { ...x.picked, 0: ['a'] } }));
    updateQuestionDraft(k, (x) => ({ ...x, picked: { ...x.picked, 1: ['b'] } }));
    expect(readQuestionDraft(k).picked).toEqual({ 0: ['a'], 1: ['b'] });
    expect(seen).toHaveBeenCalledTimes(2);
    off();
    dropQuestionDraft(k);
    expect(seen).toHaveBeenCalledTimes(2);
  });
  it('seed sets a draft only when there is none', () => {
    const d = { ...EMPTY_QUESTION_DRAFT, step: 2 };
    seedQuestionDraft(k, d);
    seedQuestionDraft(k, { ...EMPTY_QUESTION_DRAFT, step: 1 });
    expect(readQuestionDraft(k)).toBe(d);
    dropQuestionDraft(k);
  });
  it('a card that settled elsewhere loses its draft; other sessions keep theirs; a removed host clears all', () => {
    const s1 = 'p\u0000w\u0000s1';
    const s2 = 'p\u0000w\u0000s2';
    for (const [s, c] of [[s1, 'c1'], [s1, 'c2'], [s2, 'c1']] as const) updateQuestionDraft(draftKey(s, c), (x) => ({ ...x, step: 1 }));
    pruneQuestionDrafts(s1, ['c2']);
    expect(readQuestionDraft(draftKey(s1, 'c1'))).toBe(EMPTY_QUESTION_DRAFT);
    expect(readQuestionDraft(draftKey(s1, 'c2')).step).toBe(1);
    expect(readQuestionDraft(draftKey(s2, 'c1')).step).toBe(1);
    clearQuestionDrafts();
    expect(readQuestionDraft(draftKey(s1, 'c2'))).toBe(EMPTY_QUESTION_DRAFT);
    expect(readQuestionDraft(draftKey(s2, 'c1'))).toBe(EMPTY_QUESTION_DRAFT);
  });
});
