import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { S } from '../../../shared/strings.js';
import { ShortcutField } from './ShortcutField.js';

afterEach(() => cleanup());

const recordingText = S.assistant.settings.shortcutRecording;

function Harness(props: { onChange(value: string): void }): JSX.Element {
  const [value, setValue] = useState('Alt+Space');
  return (
    <ShortcutField
      value={value}
      label="Shortcut"
      onChange={(next) => {
        setValue(next);
        props.onChange(next);
      }}
    />
  );
}

describe('ShortcutField', () => {
  it('клик включает запись', () => {
    render(<ShortcutField value="Alt+Space" label="Shortcut" onChange={() => undefined} />);
    expect(screen.getByTestId('shortcut-field').textContent).toBe('⌥Space');
    fireEvent.click(screen.getByTestId('shortcut-field'));
    expect(screen.getByText(recordingText)).toBeTruthy();
  });

  it('⌥J пишет Alt+J и возвращает обычный вид', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const field = screen.getByTestId('shortcut-field');
    fireEvent.click(field);
    fireEvent.keyDown(field, { code: 'KeyJ', altKey: true });
    expect(onChange).toHaveBeenCalledWith('Alt+J');
    expect(screen.getByTestId('shortcut-field').textContent).toBe('⌥J');
  });

  it('один модификатор — запись продолжается', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const field = screen.getByTestId('shortcut-field');
    fireEvent.click(field);
    fireEvent.keyDown(field, { code: 'ShiftLeft', shiftKey: true });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText(recordingText)).toBeTruthy();
  });

  it('Escape выключает запись без onChange', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const field = screen.getByTestId('shortcut-field');
    fireEvent.click(field);
    fireEvent.keyDown(field, { code: 'Escape' });
    expect(onChange).not.toHaveBeenCalled();
    expect(field.textContent).toBe('⌥Space');
  });
});
