import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FeedQuestion, FeedQuestionCard } from '@parley/core';
import { FEED_DECISION_ANSWER_LIMIT, FEED_INPUT_LIMIT } from '@parley/protocol';
import { QuestionForm, type QuestionFormLabels, type QuestionFormProps } from './QuestionForm.js';

const labels: QuestionFormLabels = {
  back: 'Back', next: 'Next', submit: 'Submit', other: 'Other', otherAnswer: 'Your answer',
  questionOf: (at, total) => `Question ${at} of ${total}`,
  invalidQuestion: 'Open this question in Parley to answer it.',
  answerTooLong: (limit) => `Each answer must be at most ${limit} characters.`,
  openInParley: 'Open in Parley',
};
function question(text = 'Which fruit?', multiSelect = false, names = ['Apple', 'Pear']): FeedQuestion {
  return { question: text, header: 'Choice', multiSelect, options: names.map((label) => ({ label, description: `${label} description` })) };
}
function card(questions = [question()], patch: Partial<FeedQuestionCard> = {}): FeedQuestionCard {
  return { id: 'q1', cardId: 'q1', at: '2026-10-27T00:00:00Z', kind: 'question', state: 'pending', toolUseId: null, toolName: 'AskUserQuestion', toolInput: {}, questions, ...patch };
}
function props(patch: Partial<QuestionFormProps> = {}): QuestionFormProps {
  return { identity: 'ref\0q1\0fingerprint', card: card(), disabled: false, labels, onTakeKeyboard: vi.fn(), onSubmit: vi.fn(), onOpenInParley: vi.fn(), ...patch };
}
const button = (name: string): HTMLButtonElement => screen.getByRole('button', { name });
const option = (name: string): HTMLInputElement => screen.getByRole('radio', { name: `${name} ${name} description` });
const otherText = (): HTMLInputElement => screen.getByRole('textbox', { name: labels.otherAnswer });

afterEach(cleanup);

describe('QuestionForm', () => {
  it('keeps three pages through Back/Next and submits one exact single/multi/Other payload', () => {
    const p = props({ card: card([question(), question('Toppings?', true, ['Nuts', 'Cream']), question('Anything else?', false, [])]) });
    render(<QuestionForm {...p} />);
    expect(button('Next').disabled).toBe(true);
    expect(screen.getByText('Apple description')).toBeTruthy();
    fireEvent.click(option('Pear'));
    fireEvent.click(button('Next'));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Nuts Nuts description' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Cream Cream description' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Other' }));
    fireEvent.change(otherText(), { target: { value: '  Honey  ' } });
    fireEvent.click(button('Back'));
    expect(option('Pear').checked).toBe(true);
    fireEvent.click(button('Next'));
    expect(otherText().value).toBe('  Honey  ');
    fireEvent.click(button('Next'));
    expect(button('Submit').disabled).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: 'Other' }));
    fireEvent.change(otherText(), { target: { value: '  Thanks  ' } });
    expect(p.onSubmit).not.toHaveBeenCalled();
    fireEvent.click(button('Submit'));
    expect(p.onSubmit).toHaveBeenCalledOnce();
    expect(p.onSubmit).toHaveBeenCalledWith({ kind: 'question', answers: { 'Which fruit?': 'Pear', 'Toppings?': 'Nuts, Cream, Honey', 'Anything else?': 'Thanks' } });
  });

  it('single Other replaces a choice and whitespace does not count as an answer', () => {
    const p = props();
    render(<QuestionForm {...p} />);
    fireEvent.click(option('Apple'));
    fireEvent.click(screen.getByRole('radio', { name: 'Other' }));
    expect(option('Apple').checked).toBe(false);
    fireEvent.change(otherText(), { target: { value: '   ' } });
    expect(button('Submit').disabled).toBe(true);
    fireEvent.change(otherText(), { target: { value: '  Mango  ' } });
    fireEvent.click(button('Submit'));
    expect(p.onSubmit).toHaveBeenCalledWith({ kind: 'question', answers: { 'Which fruit?': 'Mango' } });
  });

  it('supports four questions and more than four options in a scrollable, no-drag body', () => {
    const names = Array.from({ length: 9 }, (_, at) => `Choice ${at}`);
    render(<QuestionForm {...props({ card: card(Array.from({ length: 4 }, (_, at) => question(`Q${at}`, false, names))) })} />);
    expect(screen.getAllByRole('radio')).toHaveLength(10);
    const body = screen.getByTestId('island-question-body');
    expect(body.hasAttribute('data-no-drag')).toBe(true);
    expect(body.className).toContain('overflow-y-auto');
    for (let at = 0; at < 3; at++) {
      fireEvent.click(option('Choice 8'));
      fireEvent.click(button('Next'));
    }
    expect(screen.getByText('Question 4 of 4')).toBeTruthy();
    expect(button('Submit').disabled).toBe(true);
  });

  it.each([
    ['empty', card([])],
    ['five questions', card(Array.from({ length: 5 }, (_, at) => question(`Q${at}`)))],
    ['duplicate question text', card([question(), question()])],
    ['duplicate labels', card([question('Which?', false, ['A', 'A'])])],
    ['empty question', card([question('   ')])],
    ['empty label', card([question('Which?', false, ['  '])])],
    ['truncated', card([question()], { truncated: true })],
    ['oversized question', card([question('Q'.repeat(FEED_INPUT_LIMIT + 1))])],
    ['oversized label', card([question('Which?', false, ['A'.repeat(FEED_INPUT_LIMIT + 1)])])],
    ['oversized description', card([{ ...question(), options: [{ label: 'A', description: 'D'.repeat(FEED_INPUT_LIMIT + 1) }] }])],
  ])('falls back safely for %s', (_, invalid) => {
    const p = props({ card: invalid });
    render(<QuestionForm {...p} />);
    expect(screen.getByText(labels.invalidQuestion)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull();
    fireEvent.click(button('Open in Parley'));
    expect(p.onOpenInParley).toHaveBeenCalledOnce();
    expect(p.onSubmit).not.toHaveBeenCalled();
  });

  it('shows answer overflow without truncating and enforces the combined multi answer limit', () => {
    const p = props({ card: card([question('Which?', true, ['A'])]) });
    render(<QuestionForm {...p} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Other' }));
    fireEvent.change(otherText(), { target: { value: 'x'.repeat(FEED_DECISION_ANSWER_LIMIT + 1) } });
    expect(otherText().value).toHaveLength(FEED_DECISION_ANSWER_LIMIT + 1);
    expect(screen.getByRole('alert').textContent).toBe(labels.answerTooLong(FEED_DECISION_ANSWER_LIMIT));
    expect(button('Submit').disabled).toBe(true);
    fireEvent.change(otherText(), { target: { value: 'x'.repeat(FEED_DECISION_ANSWER_LIMIT) } });
    expect(button('Submit').disabled).toBe(false);
    fireEvent.click(screen.getByRole('checkbox', { name: 'A A description' }));
    expect(button('Submit').disabled).toBe(true);
    fireEvent.click(button('Submit'));
    expect(p.onSubmit).not.toHaveBeenCalled();
  });

  it('preserves the active draft on refresh/failure but clears on identity or content change and unmount', () => {
    const p = props();
    const view = render(<QuestionForm {...p} />);
    fireEvent.click(option('Pear'));
    view.rerender(<QuestionForm {...p} card={{ ...p.card }} disabled />);
    expect(option('Pear').checked).toBe(true);
    expect(button('Submit').disabled).toBe(true);
    view.rerender(<QuestionForm {...p} />);
    expect(option('Pear').checked).toBe(true);
    view.rerender(<QuestionForm {...p} identity="other-ref-card-fingerprint" />);
    expect(option('Pear').checked).toBe(false);
    fireEvent.click(option('Pear'));
    view.rerender(<QuestionForm {...p} identity="other-ref-card-fingerprint" card={card([question('Changed?')])} />);
    expect(option('Pear').checked).toBe(false);
    fireEvent.click(option('Pear'));
    view.unmount();
    render(<QuestionForm {...p} />);
    expect(option('Pear').checked).toBe(false);
  });

  it('never submits on Enter/IME in Other; buttons do not take keyboard and a focused explicit Submit works after arm', () => {
    const p = props({ disabled: true });
    const view = render(<QuestionForm {...p} />);
    fireEvent.pointerDown(button('Submit'));
    fireEvent.focus(button('Submit'));
    expect(p.onTakeKeyboard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('radio', { name: 'Other' }));
    fireEvent.pointerDown(otherText());
    expect(p.onTakeKeyboard).toHaveBeenCalledOnce();
    fireEvent.change(otherText(), { target: { value: 'Mango' } });
    fireEvent.compositionStart(otherText());
    fireEvent.keyDown(otherText(), { key: 'Enter', isComposing: true });
    fireEvent.compositionEnd(otherText());
    fireEvent.keyDown(otherText(), { key: 'Enter' });
    fireEvent.keyUp(otherText(), { key: 'Enter' });
    fireEvent.click(button('Submit'));
    expect(p.onSubmit).not.toHaveBeenCalled();
    view.rerender(<QuestionForm {...p} disabled={false} />);
    button('Submit').focus();
    fireEvent.click(button('Submit'), { detail: 0 });
    expect(p.onSubmit).toHaveBeenCalledOnce();
    expect(p.onSubmit).toHaveBeenCalledWith({ kind: 'question', answers: { 'Which fruit?': 'Mango' } });
  });
});
