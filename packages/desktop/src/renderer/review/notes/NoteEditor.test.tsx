/**
 * Кусок 8.4b: поле заметки — ⌘Enter сохраняет (1–4000 символов), Esc отменяет; пустое и из одних
 * пробелов не сохраняется. Клавиши поля дальше не идут: Monaco и окно их не видят.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoteEditor } from './NoteEditor.js';

afterEach(() => {
  cleanup();
});

describe('NoteEditor', () => {
  it('⌘Enter сохраняет текст как есть; поле в фокусе, подсказка — английская', () => {
    const onSave = vi.fn();
    render(<NoteEditor initial="" onSave={onSave} onCancel={vi.fn()} />);
    const field = screen.getByRole('textbox');
    expect(document.activeElement).toBe(field);
    expect(field.getAttribute('placeholder')).toBe('Note for the agent — ⌘Enter to save');
    expect(field.getAttribute('maxlength')).toBe('4000');
    fireEvent.change(field, { target: { value: 'fix\nthis' } });
    const outer = vi.fn();
    field.parentElement?.parentElement?.addEventListener('keydown', outer);
    fireEvent.keyDown(field, { key: 'Enter', metaKey: true });
    expect(onSave).toHaveBeenCalledWith('fix\nthis');
    expect(outer).not.toHaveBeenCalled();
  });

  it('пустое и пробелы — не сохраняются; Save неактивна', () => {
    const onSave = vi.fn();
    render(<NoteEditor initial="" onSave={onSave} onCancel={vi.fn()} />);
    const field = screen.getByRole('textbox');
    fireEvent.change(field, { target: { value: '   \n ' } });
    fireEvent.keyDown(field, { key: 'Enter', metaKey: true });
    expect(onSave).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('Esc и Cancel отменяют; правка начинается с прежнего текста; Save — кнопкой', () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    render(<NoteEditor initial="old" onSave={onSave} onCancel={onCancel} />);
    const field = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(field.value).toBe('old');
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(2);
    fireEvent.change(field, { target: { value: 'new' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith('new');
  });
});
