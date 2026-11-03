import { describe, expect, it, vi } from 'vitest';
import type { FeedPermissionCard, FeedQuestionCard } from '@parley/core';
import { answerOf as windowAnswerOf } from '../../../desktop/src/renderer/lib/question-answer';
import {
  alwaysRules,
  answerOf,
  backStep,
  canNext,
  canSend,
  hasBack,
  nextStep,
  stepAnnouncement,
  stepLabel,
  stepNote,
  stepOf,
  TOO_LONG_TEXT,
  UNANSWERABLE_TEXT,
  unanswerableReason,
  canAlways,
  EMPTY_QUESTION_DRAFT,
  fullCommand,
  gistView,
  questionDecision,
  runDecision,
  timeAgo,
  togglePick,
  toggleOther,
  uiOfDecide,
} from './model';

const perm = (suggestions: unknown[]): FeedPermissionCard =>
  ({ kind: 'permission', cardId: 'c', state: 'pending', suggestions, toolName: 'Bash', toolInput: {} }) as unknown as FeedPermissionCard;

describe('Allow and don\'t ask again', () => {
  it('a card without permission_suggestions never offers "Always"', () => {
    expect(canAlways(perm([]))).toBe(false);
    expect(canAlways(perm([{ type: 'setMode', mode: 'acceptEdits' }]))).toBe(false);
    expect(canAlways(perm([{ type: 'addRules', rules: [] }]))).toBe(false);
  });
  it('a suggested addRules rule shows as Tool(content)', () => {
    const s = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'pnpm lint:*' }, { toolName: 'Read' }] }];
    expect(alwaysRules(s)).toEqual(['Bash(pnpm lint:*)', 'Read']);
    expect(canAlways(perm(s))).toBe(true);
  });
});

describe('gistView', () => {
  it('maps gists to icons, titles and summaries', () => {
    expect(gistView({ kind: 'run', command: 'pnpm lint' })).toMatchObject({ icon: 'terminal', title: 'Run a command', mono: true });
    expect(gistView({ kind: 'tool', tool: 'Edit', path: 'src/a.ts' })).toMatchObject({ icon: 'doc.text', summary: 'Edit · src/a.ts' });
    expect(gistView({ kind: 'tool', tool: 'mcp__x', path: null })).toMatchObject({ icon: 'wrench.and.screwdriver', title: 'Use mcp__x' });
    expect(gistView({ kind: 'fetch', url: 'https://example.com/a?b' })).toMatchObject({ icon: 'globe', summary: 'example.com' });
  });
});

describe('questions', () => {
  const card = {
    kind: 'question',
    cardId: 'q',
    state: 'pending',
    questions: [
      { question: 'Branch?', header: null, options: [{ label: 'main', description: null }, { label: 'dev', description: null }], multiSelect: false },
      { question: 'Checks?', header: null, options: [{ label: 'lint', description: null }, { label: 'test', description: null }], multiSelect: true },
    ],
  } as unknown as FeedQuestionCard;

  it('is not sendable until every question has an answer', () => {
    expect(questionDecision(card, EMPTY_QUESTION_DRAFT)).toBeNull();
    let d = togglePick(EMPTY_QUESTION_DRAFT, 0, card.questions[0]!, 'main');
    expect(questionDecision(card, d)).toBeNull();
    d = togglePick(d, 1, card.questions[1]!, 'lint');
    d = togglePick(d, 1, card.questions[1]!, 'test');
    expect(questionDecision(card, d)).toEqual({ kind: 'question', answers: { 'Branch?': 'main', 'Checks?': 'lint, test' } });
  });
  it('"Other" replaces a single choice and joins a multi-choice', () => {
    let d = togglePick(EMPTY_QUESTION_DRAFT, 0, card.questions[0]!, 'main');
    d = toggleOther(d, 0, card.questions[0]!);
    d = { ...d, otherText: { 0: '  feature  ' } };
    d = togglePick(d, 1, card.questions[1]!, 'lint');
    d = toggleOther(d, 1, card.questions[1]!);
    d = { ...d, otherText: { ...d.otherText, 1: 'e2e' } };
    expect(questionDecision(card, d)).toEqual({ kind: 'question', answers: { 'Branch?': 'feature', 'Checks?': 'lint, e2e' } });
  });
  it('a settled card cannot be answered', () => {
    expect(questionDecision({ ...card, state: 'settled' } as unknown as FeedQuestionCard, EMPTY_QUESTION_DRAFT)).toBeNull();
  });
});

describe('runDecision', () => {
  const allow = { kind: 'permission', behavior: 'allow' } as const;
  it('lost is never retried and keeps or drops the card by the re-read', async () => {
    const send = vi.fn(async () => ({ outcome: 'lost' as const, stillPending: true }));
    expect(await runDecision(allow, send)).toEqual({ kind: 'unconfirmed' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(uiOfDecide({ outcome: 'lost', stillPending: false })).toEqual({ kind: 'no-longer-pending' });
    expect(uiOfDecide({ outcome: 'lost', stillPending: null })).toEqual({ kind: 'unconfirmed' });
    expect(uiOfDecide({ outcome: 'stale' })).toEqual({ kind: 'already-answered' });
    expect(uiOfDecide({ outcome: 'conflict' })).toEqual({ kind: 'conflict' });
  });
  it('a thrown send is an error, not a crash', async () => {
    expect(await runDecision(allow, async () => { throw new Error('bad_request'); })).toEqual({ kind: 'error' });
  });
});

describe('timeAgo', () => {
  const now = Date.parse('2026-10-31T12:00:00Z');
  it('formats minutes, hours, days', () => {
    expect(timeAgo('2026-10-31T11:58:00Z', now)).toBe('2 min');
    expect(timeAgo('2026-10-31T10:00:00Z', now)).toBe('2 h');
    expect(timeAgo('2026-10-29T12:00:00Z', now)).toBe('2 d');
    expect(timeAgo(null, now)).toBeNull();
  });
});

describe('fullCommand', () => {
  it('returns the whole multi-line command, or null for non-command cards', () => {
    const card = (toolInput: unknown) => ({ kind: 'permission', toolInput }) as unknown as FeedPermissionCard;
    expect(fullCommand(card({ command: 'a\nb' }))).toBe('a\nb');
    expect(fullCommand(card({ command: ['git', 'push'] }))).toBe('git push');
    expect(fullCommand(card({ file_path: 'x' }))).toBeNull();
    expect(fullCommand({ kind: 'plan' } as never)).toBeNull();
  });
});

describe('question steps', () => {
  const q = (question: string, multiSelect: boolean) => ({ question, header: null, options: [{ label: 'a', description: null }, { label: 'b', description: null }], multiSelect });
  const three = { kind: 'question', cardId: 'q3', state: 'pending', questions: [q('One?', false), q('Two?', true), q('Three?', false)] } as unknown as FeedQuestionCard;
  const one = { kind: 'question', cardId: 'q1', state: 'pending', questions: [q('Only?', false)] } as unknown as FeedQuestionCard;
  const pick = (d: typeof EMPTY_QUESTION_DRAFT, at: number, label: string) => togglePick(d, at, three.questions[at]!, label);

  it('Next is disabled without an answer, then moves one step', () => {
    expect(canNext(three, EMPTY_QUESTION_DRAFT)).toBe(false);
    expect(nextStep(three, EMPTY_QUESTION_DRAFT)).toBe(EMPTY_QUESTION_DRAFT);
    const d = nextStep(three, pick(EMPTY_QUESTION_DRAFT, 0, 'a'));
    expect(d.step).toBe(1);
    expect(stepLabel(d, 3)).toBe('Question 2 of 3');
    expect(canNext(three, d)).toBe(false);
  });
  it('Back appears from the second question and keeps the picks', () => {
    expect(hasBack(EMPTY_QUESTION_DRAFT, 3)).toBe(false);
    const d = nextStep(three, pick(EMPTY_QUESTION_DRAFT, 0, 'b'));
    expect(hasBack(d, 3)).toBe(true);
    const back = backStep(three, d);
    expect(back.step).toBe(0);
    expect(back.picked[0]).toEqual(['b']);
    expect(backStep(three, back)).toBe(back);
  });
  it('Send answer only on the last question and only with every answer', () => {
    let d = pick(EMPTY_QUESTION_DRAFT, 0, 'a');
    d = nextStep(three, pick(d, 1, 'a'));
    expect(canSend(three, d)).toBe(false); // not the last
    d = nextStep(three, d);
    expect(canNext(three, d)).toBe(false); // the last has no Next
    expect(canSend(three, d)).toBe(false); // no answer to the last
    d = pick(d, 2, 'b');
    expect(canSend(three, d)).toBe(true);
    // an earlier question unanswered (picked cleared) blocks Send
    expect(canSend(three, { ...d, picked: { ...d.picked, 0: [] } })).toBe(false);
  });
  it('a single question has no "1 of 1" and no Back, and sends at once', () => {
    expect(stepLabel(EMPTY_QUESTION_DRAFT, 1)).toBeNull();
    expect(hasBack(EMPTY_QUESTION_DRAFT, 1)).toBe(false);
    expect(canSend(one, EMPTY_QUESTION_DRAFT)).toBe(false);
    expect(canSend(one, togglePick(EMPTY_QUESTION_DRAFT, 0, one.questions[0]!, 'a'))).toBe(true);
  });
  it('a stored step past the card end is clamped', () => {
    expect(stepOf({ ...EMPTY_QUESTION_DRAFT, step: 9 }, 3)).toBe(2);
    expect(stepOf({ ...EMPTY_QUESTION_DRAFT, step: -1 }, 3)).toBe(0);
  });
  it('the payload equals the window\'s on the same answers (single, multi, Other)', () => {
    let d = pick(EMPTY_QUESTION_DRAFT, 0, 'a');
    d = toggleOther(pick(pick(d, 1, 'a'), 1, 'b'), 1, three.questions[1]!);
    d = { ...d, otherText: { 1: '  mine ' } };
    d = toggleOther(d, 2, three.questions[2]!);
    d = { ...d, otherText: { ...d.otherText, 2: ' typed ' }, step: 2 };
    const expected: Record<string, string> = {};
    three.questions.forEach((x, at) => { expected[x.question] = windowAnswerOf(x, at, d); });
    expect(expected).toEqual({ 'One?': 'a', 'Two?': 'a, b, mine', 'Three?': 'typed' });
    expect(questionDecision(three, d)).toEqual({ kind: 'question', answers: expected });
    three.questions.forEach((x, at) => expect(answerOf(x, at, d)).toBe(windowAnswerOf(x, at, d)));
  });
});

describe('question steps — validity and announcement (A45 review)', () => {
  const q = (question: string) => ({ question, header: null, options: [{ label: 'a', description: null }], multiSelect: false });
  const card = (over: object, questions = [q('One?'), q('Two?')]) => ({ kind: 'question', cardId: 'c', state: 'pending', questions, ...over }) as unknown as FeedQuestionCard;
  const typed = (text: string) => ({ ...toggleOther(EMPTY_QUESTION_DRAFT, 0, q('One?')), otherText: { 0: text } });

  it('Next refuses an answer over the 16 KB limit and says why', () => {
    const c = card({});
    expect(canNext(c, typed('x'.repeat(16 * 1024)))).toBe(true);
    expect(canNext(c, typed('x'.repeat(16 * 1024 + 1)))).toBe(false);
    expect(stepNote(c, typed('x'.repeat(16 * 1024 + 1)))).toBe(TOO_LONG_TEXT);
    expect(stepNote(c, typed('fine'))).toBeNull();
  });
  it('a truncated card or duplicate question texts say so from the first question and block Next', () => {
    for (const c of [card({ truncated: true }), card({}, [q('Same?'), q('Same?')])]) {
      expect(unanswerableReason(c)).toBe(UNANSWERABLE_TEXT);
      expect(stepNote(c, EMPTY_QUESTION_DRAFT)).toBe(UNANSWERABLE_TEXT);
      expect(canNext(c, togglePick(EMPTY_QUESTION_DRAFT, 0, c.questions[0]!, 'a'))).toBe(false);
    }
    expect(unanswerableReason(card({}))).toBeNull();
  });
  it('announces "Question i of N. text", and just the text for a single question', () => {
    const c = card({});
    expect(stepAnnouncement(c, EMPTY_QUESTION_DRAFT)).toBe('Question 1 of 2. One?');
    expect(stepAnnouncement(c, { ...EMPTY_QUESTION_DRAFT, step: 1 })).toBe('Question 2 of 2. Two?');
    expect(stepAnnouncement(card({}, [q('Only?')]), EMPTY_QUESTION_DRAFT)).toBe('Only?');
  });
});
