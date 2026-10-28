import { describe, expect, it } from 'vitest';
import type { FeedPermissionCard, FeedPlanCard, FeedQuestionCard, Proposal } from '@parley/core';
import type { AssistantProposal, ConsentCard } from '@parley/protocol';
import { ASSISTANT_CARD_MAX, assistantCardMessage, consentCardMessage, feedCardMessage, feedDecisionFor, questionKeyboard, receiptText, roomCardMessage, type CardMeta } from './cards.js';

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

  describe('карточка actions', () => {
    const ACTIONS: Extract<AssistantProposal, { action: 'actions' }> = {
      ...common,
      id: 'p7',
      action: 'actions',
      target: '2 steps',
      text: 'Update Parley…',
      steps: [
        { verb: 'sleep', line: 'Put S03 Ruslan to sleep', text: null, danger: false },
        { verb: 'close', line: 'Close S05 Vera for good', text: null, danger: true },
      ],
    };
    const oneStep = (verb: Extract<AssistantProposal, { action: 'actions' }>['steps'][number]['verb']): AssistantProposal => ({
      ...ACTIONS,
      steps: [{ verb, line: 'Do it', text: null, danger: false }],
    });

    it('шаги, close с предупреждением, «Do all (2)»', () => {
      const { text, keyboard } = assistantCardMessage(ACTIONS);
      expect(text).toContain('Plan in Parley · my_harnas');
      expect(text).toContain('<b>1.</b> Put S03 Ruslan to sleep');
      expect(text).toContain('<b>2.</b> Close S05 Vera for good — closes for good');
      expect(keyboard[0]?.[0]).toEqual({ text: 'Do all (2)', callback_data: 'pa1:p7:send' });
      expect(keyboard[0]?.[1]).toEqual({ text: 'Cancel', callback_data: 'pa1:p7:cancel' });
    });
    it('один шаг — глагол шага на кнопке', () => {
      expect(labelOf(oneStep('create_work'))).toBe('Create');
      expect(labelOf(oneStep('create_session'))).toBe('Create');
      expect(labelOf(oneStep('create_room'))).toBe('Create');
      expect(labelOf(oneStep('wake'))).toBe('Wake');
      expect(labelOf(oneStep('interrupt'))).toBe('Stop');
      expect(labelOf(oneStep('sleep'))).toBe('Put to sleep');
      expect(labelOf(oneStep('close'))).toBe('Close');
      expect(labelOf(oneStep('add_to_room'))).toBe('Add');
      expect(labelOf(oneStep('message'))).toBe('Send');
    });
    it('текст шага — под строкой в pre и экранирован', () => {
      const { text } = assistantCardMessage({ ...ACTIONS, steps: [{ verb: 'message', line: 'Message S03 Ruslan', text: 'a <b> & c', danger: false }] });
      expect(text).toContain('<b>1.</b> Message S03 Ruslan\n<pre>a &lt;b&gt; &amp; c</pre>');
    });
    it('20 шагов с текстами по 300 знаков влезают в 4096', () => {
      const steps = Array.from({ length: 20 }, (_, i) => ({ verb: 'message' as const, line: `Message room "Room with a very long name number ${i}"`, text: 'x'.repeat(300), danger: false }));
      const { text } = assistantCardMessage({ ...ACTIONS, steps });
      expect(text.length).toBeLessThanOrEqual(ASSISTANT_CARD_MAX);
      expect(text).toContain('<pre>');
    });
    it('не влезает с текстами по 100 знаков — тексты убираются', () => {
      const steps = Array.from({ length: 20 }, (_, i) => ({ verb: 'message' as const, line: `Message room "${'R'.repeat(80)}" ${i}`, text: 'x'.repeat(300), danger: false }));
      const { text } = assistantCardMessage({ ...ACTIONS, steps });
      expect(text.length).toBeLessThanOrEqual(ASSISTANT_CARD_MAX);
      expect(text).not.toContain('<pre>');
      expect(text).toContain('<b>20.</b>');
    });
    it('не влезает и без текстов — строки режутся до 120 знаков, предупреждение close остаётся', () => {
      const steps = Array.from({ length: 20 }, (_, i) => ({ verb: 'close' as const, line: `Close ${'W'.repeat(280)} ${i}`, text: null, danger: true }));
      const { text } = assistantCardMessage({ ...ACTIONS, steps });
      expect(text.length).toBeLessThanOrEqual(ASSISTANT_CARD_MAX);
      expect(text).toContain('<b>20.</b>');
      expect(text.split('— closes for good')).toHaveLength(21);
    });
  });
});

describe('receiptText', () => {
  it('исходный текст, пустая строка, итог', () => {
    expect(receiptText('<b>a</b>', 'Allowed at 10:00')).toBe('<b>a</b>\n\nAllowed at 10:00');
  });
});

describe('consentCardMessage', () => {
  const card: ConsentCard = {
    id: 'c-01',
    kind: 'folder-trust',
    folder: '/Users/me/code/<app> & co',
    projectPath: '/Users/me/code/my_harnas',
    requestedBy: { source: 'agent', sessionId: 's-03', label: 'S03 Ruslan' },
    at: '2026-10-21T10:00:00Z',
    state: 'pending',
  };
  it('текст: заголовок, папка, «Requested by …»; HTML экранирован', () => {
    const { text } = consentCardMessage({ card, projectName: 'my_harnas', requestedByLabel: 'S03 Ruslan (agent)', shortId: 'cn1' });
    expect(text).toBe('<b>Trust folder for agents?</b>\n/Users/me/code/&lt;app&gt; &amp; co\nRequested by S03 Ruslan (agent) · my_harnas');
  });
  it('подпись запросившего тоже экранирована', () => {
    const { text } = consentCardMessage({ card, projectName: 'a<b>', requestedByLabel: '<x>', shortId: 'cn1' });
    expect(text).toContain('Requested by &lt;x&gt; · a&lt;b&gt;');
    expect(text).not.toContain('<x>');
  });
  it('клавиатура: Trust и Deny → pc1:<shortId>:a и :d', () => {
    const { keyboard } = consentCardMessage({ card, projectName: 'my_harnas', requestedByLabel: 'agent', shortId: 'cn1' });
    expect(keyboard).toEqual([
      [
        { text: 'Trust', callback_data: 'pc1:cn1:a' },
        { text: 'Deny', callback_data: 'pc1:cn1:d' },
      ],
    ]);
  });
});
