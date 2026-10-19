import { describe, expect, it } from 'vitest';
import type { FeedPermissionCard, FeedPlanCard, FeedQuestionCard, Proposal } from '@parley/core';
import type { AssistantProposal } from '@parley/protocol';
import { assistantCardMessage, feedCardMessage, feedDecisionFor, questionKeyboard, receiptText, roomCardMessage, type CardMeta } from './cards.js';

const meta: CardMeta = { sessionName: 'S03 Ruslan', where: 'Parley · my_harnas', projectPath: '/p/my_harnas', shortId: 'aB3dE9fG', buttons: true };

const base = { id: 'c1', at: '2026-10-20T10:00:00Z', cardId: 'c1', state: 'pending', toolUseId: null, toolName: 'Bash' } as const;

const permission = (suggestions: unknown[] = [], command = 'ls'): FeedPermissionCard => ({ ...base, kind: 'permission', toolInput: { command }, suggestions, notified: false });
const plan: FeedPlanCard = { ...base, kind: 'plan', toolName: 'ExitPlanMode', toolInput: {}, plan: 'Do the thing', planFilePath: null };
const question = (labels: string[], extra = false): FeedQuestionCard => ({
  ...base,
  kind: 'question',
  toolName: 'AskUserQuestion',
  toolInput: {},
  questions: [
    { question: 'Which one?', header: null, multiSelect: false, options: labels.map((label) => ({ label, description: null })) },
    ...(extra ? [{ question: 'And then?', header: null, multiSelect: false, options: [{ label: 'Yes', description: null }] }] : []),
  ],
});

const codes = (keyboard: Array<Array<{ callback_data: string }>> | null): string[] => (keyboard ?? []).flat().map((b) => b.callback_data);

describe('feedCardMessage', () => {
  it('permission с suggestions: три кнопки pc1:<shortId>:a|A|d', () => {
    const { text, keyboard } = feedCardMessage(permission([{}]), meta);
    expect(codes(keyboard)).toEqual(['pc1:aB3dE9fG:a', 'pc1:aB3dE9fG:d', 'pc1:aB3dE9fG:A']);
    expect(text).toContain('<b>S03 Ruslan</b> · Parley · my_harnas');
    expect(text).toContain('Permission: Bash');
    expect(text).toContain('Valid until the agent turn ends.');
  });
  it('permission без suggestions: две кнопки', () => {
    expect(codes(feedCardMessage(permission(), meta).keyboard)).toEqual(['pc1:aB3dE9fG:a', 'pc1:aB3dE9fG:d']);
  });
  it('buttons:false: без клавиатуры, со строкой про Mac', () => {
    const { text, keyboard } = feedCardMessage(permission(), { ...meta, buttons: false });
    expect(keyboard).toBeNull();
    expect(text).toContain('S03 Ruslan is waiting for you at the Mac.');
  });
  it('экранирует HTML в команде', () => {
    const { text } = feedCardMessage(permission([], 'rm -rf <dist>'), meta);
    expect(text).toContain('<pre>rm -rf &lt;dist&gt;</pre>');
    expect(text).not.toContain('<dist>');
  });
  it('plan: Accept и Approve each edit → p и m', () => {
    const { text, keyboard } = feedCardMessage(plan, meta);
    expect(codes(keyboard)).toEqual(['pc1:aB3dE9fG:p', 'pc1:aB3dE9fG:m']);
    expect(text).toContain('Plan');
  });
  it('question с тремя вариантами: три кнопки и Other…', () => {
    const { keyboard, text } = feedCardMessage(question(['A', 'B', 'C']), meta);
    expect(codes(keyboard)).toEqual(['pc1:aB3dE9fG:q0', 'pc1:aB3dE9fG:q1', 'pc1:aB3dE9fG:q2', 'pc1:aB3dE9fG:o']);
    expect(keyboard?.at(-1)?.[0]?.text).toBe('Other…');
    expect(text).toContain('Question');
  });
  it('несколько вопросов: заголовок «Question 2 of 2» и только второй вопрос', () => {
    const { text, keyboard } = feedCardMessage(question(['A'], true), meta, 1);
    expect(text).toContain('Question 2 of 2');
    expect(text).toContain('And then?');
    expect(text).not.toContain('Which one?');
    expect(codes(keyboard)).toEqual(['pc1:aB3dE9fG:q0', 'pc1:aB3dE9fG:o']);
  });
});

describe('questionKeyboard', () => {
  it('подпись длиннее 64 знаков обрезана', () => {
    const [row] = questionKeyboard(question(['x'.repeat(200)]), 'sid', 0);
    expect(row?.[0]?.text).toHaveLength(64);
  });
});

describe('feedDecisionFor', () => {
  it('permission: a, A, d', () => {
    expect(feedDecisionFor(permission([{}]), 'a')).toEqual({ kind: 'permission', behavior: 'allow' });
    expect(feedDecisionFor(permission([{}]), 'A')).toEqual({ kind: 'permission', behavior: 'allow', always: true });
    expect(feedDecisionFor(permission(), 'A')).toBeNull();
    expect(feedDecisionFor(permission(), 'd')).toEqual({ kind: 'permission', behavior: 'deny' });
  });
  it('plan: p и m → choice', () => {
    expect(feedDecisionFor(plan, 'p')).toEqual({ kind: 'plan', choice: 'auto-accept' });
    expect(feedDecisionFor(plan, 'm')).toEqual({ kind: 'plan', choice: 'manual' });
  });
  it('question: q1 → ответ-подпись, o → other, o с текстом → свой ответ', () => {
    const card = question(['A', 'B', 'C']);
    expect(feedDecisionFor(card, 'q1')).toEqual({ kind: 'question', answers: { 'Which one?': 'B' } });
    expect(feedDecisionFor(card, 'q9')).toBeNull();
    expect(feedDecisionFor(card, 'o')).toBe('other');
    expect(feedDecisionFor(card, 'o', 'my own')).toEqual({ kind: 'question', answers: { 'Which one?': 'my own' } });
  });
  it('чужой код → null', () => {
    expect(feedDecisionFor(plan, 'a')).toBeNull();
  });
});

describe('roomCardMessage', () => {
  const proposal: Proposal = { id: 'p-01', from: 'S01', text: 'Ship <it>', rev: 1, at: '2026-10-20T10:00:00Z' };
  it('Accept и Return… с pc1-кодами y и r, текст экранирован, пометка Revised', () => {
    const { text, keyboard } = roomCardMessage({ roomTitle: 'Auth', where: 'Parley · my_harnas', proposal, shortId: 'rm1' });
    expect(codes(keyboard)).toEqual(['pc1:rm1:y', 'pc1:rm1:r']);
    expect(text).toContain('<b>Auth</b>');
    expect(text).toContain('Ship &lt;it&gt;');
    expect(text).toContain('Revised version');
  });
});

describe('assistantCardMessage', () => {
  const common = { id: 'pr1', target: 'S03 Ruslan', where: 'Parley · my_harnas', text: 'hi' };
  const labelOf = (proposal: AssistantProposal): string => assistantCardMessage(proposal).keyboard[0]?.[0]?.text ?? '';
  const decision = (d: Extract<AssistantProposal, { action: 'decision' }>['decision']): AssistantProposal => ({
    ...common,
    action: 'decision',
    card: { cardId: 'c1', kind: 'permission', summary: 'Run ls', detail: 'ls' },
    decision: d,
  });

  it('кнопки pa1:<id>:send|cancel', () => {
    const { keyboard } = assistantCardMessage({ ...common, kind: null, wake: false });
    expect(codes(keyboard)).toEqual(['pa1:pr1:send', 'pa1:pr1:cancel']);
  });
  it('подписи по action', () => {
    expect(labelOf({ ...common, kind: null, wake: false })).toBe('Send');
    expect(labelOf({ ...common, action: 'room', title: 'Auth', members: ['S01'], lead: 'S01', task: null })).toBe('Create');
    expect(labelOf(decision({ kind: 'permission', behavior: 'allow' }))).toBe('Allow');
    expect(labelOf(decision({ kind: 'permission', behavior: 'deny' }))).toBe('Deny');
    expect(labelOf(decision({ kind: 'question', answers: { q: 'a' } }))).toBe('Answer');
    expect(labelOf(decision({ kind: 'plan', choice: 'auto-accept' }))).toBe('Accept plan');
    expect(labelOf(decision({ kind: 'plan', choice: 'manual' }))).toBe('Approve each edit');
    const roomDecision = { ...common, action: 'room-decision', proposal: { proposalId: 'p-01', rev: 0, kind: 'decision', from: 'S01', text: 'x' }, note: null } as const;
    expect(labelOf({ ...roomDecision, choice: 'accept' })).toBe('Accept');
    expect(labelOf({ ...roomDecision, choice: 'return' })).toBe('Return');
  });
  it('текст письма экранирован', () => {
    expect(assistantCardMessage({ ...common, text: '<b>x</b>', kind: null, wake: false }).text).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});

describe('receiptText', () => {
  it('исходный текст, пустая строка, итог', () => {
    expect(receiptText('<b>a</b>', 'Allowed at 10:00')).toBe('<b>a</b>\n\nAllowed at 10:00');
  });
});
