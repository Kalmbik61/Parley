/**
 * Тест 2 куска 3.6 плана окна: «всем» → `to: []`; выбраны двое → их id;
 * закрытого выбрать нельзя. Кусок 1.4 плана «облик Orca»: адресаты —
 * `ui/checkbox` (кнопка с `role="checkbox"`, а не `input[type="checkbox"]`),
 * поэтому отмеченность читается через `aria-checked`, а не `.checked`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComposerSubmission } from './Composer.js';
import { Composer } from './Composer.js';

afterEach(cleanup);

const MEMBERS = [
  { id: 's-01', label: 'S01 (Claude)', closed: false },
  { id: 's-02', label: 'S02 (Codex)', closed: false },
  { id: 's-03', label: 'S03 (закрыта)', closed: true },
];

function typeAndSend(text: string): void {
  const textarea = screen.getByPlaceholderText('⌘Enter to send');
  fireEvent.change(textarea, { target: { value: text } });
  fireEvent.click(screen.getByText('Send'));
}

describe('Composer — тест 2', () => {
  it('по умолчанию «всем» — to: []', () => {
    const sent: ComposerSubmission[] = [];
    render(<Composer members={MEMBERS} onSend={(submission) => sent.push(submission)} />);

    typeAndSend('привет всем');

    expect(sent).toEqual([{ to: [], text: 'привет всем', kind: 'note' }]);
  });

  it('выбраны двое — их id, «всем» снимается само', () => {
    const sent: ComposerSubmission[] = [];
    render(<Composer members={MEMBERS} onSend={(submission) => sent.push(submission)} />);

    fireEvent.click(screen.getByLabelText('S01 (Claude)'));
    fireEvent.click(screen.getByLabelText('S02 (Codex)'));
    typeAndSend('двоим');

    expect(sent[0]?.to.sort()).toEqual(['s-01', 's-02']);
    expect(screen.getByLabelText('everyone').getAttribute('aria-checked')).toBe('false');
  });

  it('закрытого участника выбрать нельзя', () => {
    render(<Composer members={MEMBERS} onSend={() => {}} />);

    const closedCheckbox = screen.getByLabelText('S03 (закрыта)') as HTMLButtonElement;
    expect(closedCheckbox.disabled).toBe(true);

    fireEvent.click(closedCheckbox);
    expect(closedCheckbox.getAttribute('aria-checked')).toBe('false');
  });
});
