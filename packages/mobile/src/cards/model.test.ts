import { describe, expect, it, vi } from 'vitest';
import type { FeedPermissionCard, FeedQuestionCard } from '@parley/core';
import {
  alwaysRules,
  canAlways,
  EMPTY_QUESTION_DRAFT,
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

describe('runDecision (spec §11.4)', () => {
  const allow = { kind: 'permission', behavior: 'allow' } as const;
  it('Deny and answers skip the gate; approvals go through it', async () => {
    const approve = vi.fn(async (kind: string) => kind !== '');
    const send = vi.fn(async () => ({ outcome: 'applied' as const }));
    await runDecision({ kind: 'permission', behavior: 'deny' }, approve, send);
    await runDecision({ kind: 'question', answers: {} }, approve, send);
    expect(approve).not.toHaveBeenCalled();
    await runDecision(allow, approve, send);
    await runDecision({ ...allow, always: true }, approve, send);
    await runDecision({ kind: 'plan', choice: 'manual' }, approve, send);
    expect(approve.mock.calls.map((c) => c[0])).toEqual(['allow', 'always', 'plan']);
  });
  it('a cancelled gate sends nothing and the card stays', async () => {
    const send = vi.fn();
    expect(await runDecision(allow, async () => false, send)).toEqual({ kind: 'cancelled' });
    expect(await runDecision(allow, async () => { throw new Error('x'); }, send)).toEqual({ kind: 'cancelled' });
    expect(send).not.toHaveBeenCalled();
  });
  it('lost is never retried and keeps or drops the card by the re-read', async () => {
    const send = vi.fn(async () => ({ outcome: 'lost' as const, stillPending: true }));
    expect(await runDecision(allow, async () => true, send)).toEqual({ kind: 'unconfirmed' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(uiOfDecide({ outcome: 'lost', stillPending: false })).toEqual({ kind: 'no-longer-pending' });
    expect(uiOfDecide({ outcome: 'lost', stillPending: null })).toEqual({ kind: 'unconfirmed' });
    expect(uiOfDecide({ outcome: 'stale' })).toEqual({ kind: 'already-answered' });
    expect(uiOfDecide({ outcome: 'conflict' })).toEqual({ kind: 'conflict' });
  });
  it('a thrown send is an error, not a crash', async () => {
    expect(await runDecision(allow, async () => true, async () => { throw new Error('bad_request'); })).toEqual({ kind: 'error' });
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
