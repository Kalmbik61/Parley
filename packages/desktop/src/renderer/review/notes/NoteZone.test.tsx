/**
 * Кусок 8.4b, тест 2: карточка заметки — текст, автор `You`, время `en-US`, «Edit», «Delete»,
 * «Send»; отправленная свёрнута в строку `Sent to S02 · 2:05 PM`, устаревшая — с меткой
 * `Outdated`. Кнопки только сообщают о нажатии: отправки из карточки без нажатия нет.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiffNote } from '../../../shared/notes-types.js';
import { makeSession, makeWork } from '../../test-utils/work-fixtures.js';
import { NoteZone } from './NoteZone.js';

afterEach(() => {
  cleanup();
});

const ENTRY = makeWork('w-01', { sessions: [makeSession('s-02', 'executor'), makeSession('s-03', 'reviewer')] });
/** Местное 14:05 — `en-US` показывает его как 2:05 PM в любом поясе машины. */
const AT = new Date(2026, 8, 27, 14, 5).toISOString();

function note(overrides: Partial<DiffNote> = {}): DiffNote {
  return {
    id: 'aaaaaaaa',
    path: 'src/a.ts',
    side: 'modified',
    startLine: 10,
    endLine: 14,
    body: 'rename this\nand that',
    createdAt: AT,
    updatedAt: AT,
    sentAt: null,
    sentTo: null,
    anchor: { text: 'line 10' },
    stale: false,
    ...overrides,
  };
}

function renderZone(value: DiffNote, handlers: Partial<{ onEdit(): void; onDelete(): void; onSend(to: string): void }> = {}) {
  const props = { onEdit: vi.fn(), onDelete: vi.fn(), onSend: vi.fn(), ...handlers };
  render(<NoteZone note={value} entry={ENTRY} defaultSessionId="s-02" {...props} />);
  return props;
}

describe('NoteZone (тест 2 куска 8.4b)', () => {
  it('текст как есть, You, время en-US, Edit, Delete, Send — каждая кнопка зовёт свой обработчик', () => {
    const props = renderZone(note());
    const zone = screen.getByTestId('note-zone');
    expect(zone.textContent).toContain('rename this\nand that');
    expect(zone.textContent).toContain('You');
    expect(zone.textContent).toContain('2:05 PM');
    expect(props.onSend).not.toHaveBeenCalled();

    fireEvent.click(within(zone).getByRole('button', { name: 'Edit' }));
    expect(props.onEdit).toHaveBeenCalledTimes(1);
    fireEvent.click(within(zone).getByRole('button', { name: 'Delete' }));
    expect(props.onDelete).toHaveBeenCalledTimes(1);
    fireEvent.click(within(zone).getByRole('button', { name: /^Send/ }));
    expect(props.onSend).toHaveBeenCalledWith('s-02');
  });

  it('отправленная — строка Sent to S02 · 2:05 PM без Edit и Send; удалить можно', () => {
    const props = renderZone(note({ sentAt: AT, sentTo: 's-02' }));
    const zone = screen.getByTestId('note-zone');
    expect(zone.textContent).toContain('Sent to S02 · 2:05 PM');
    expect(within(zone).queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(within(zone).queryByRole('button', { name: /^Send/ })).toBeNull();
    fireEvent.click(within(zone).getByRole('button', { name: 'Delete' }));
    expect(props.onDelete).toHaveBeenCalledTimes(1);
  });

  it('устаревшая — приглушена с меткой Outdated; отправить её можно только своей кнопкой', () => {
    const props = renderZone(note({ stale: true }));
    const zone = screen.getByTestId('note-zone');
    expect(within(zone).getByText('Outdated')).toBeTruthy();
    expect(zone.getAttribute('data-stale')).toBe('true');
    fireEvent.click(within(zone).getByRole('button', { name: /^Send/ }));
    expect(props.onSend).toHaveBeenCalledWith('s-02');
  });

  it('подпись полосы одной колонки и длинный текст: полный текст — в title, ничего не вылезает', () => {
    const long = 'x'.repeat(4000);
    render(
      <NoteZone
        note={note({ side: 'original', startLine: 7, endLine: 7, body: long })}
        entry={ENTRY}
        defaultSessionId="s-02"
        caption="Original · line 7"
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onSend={vi.fn()}
      />,
    );
    const zone = screen.getByTestId('note-zone');
    expect(zone.textContent).toContain('Original · line 7');
    const body = within(zone).getByTestId('note-body');
    expect(body.getAttribute('title')).toBe(long);
    expect(body.className).toMatch(/break-words/);
    expect(body.className).toMatch(/overflow-y-auto/);
  });
});
