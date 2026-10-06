import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { S } from '../../shared/strings.js';
import { DEFAULT_UI } from '../../shared/ui-types.js';
import { useUiStore } from '../store/ui.js';
import { useDictationStore } from './dictation-store.js';
import { formatElapsed, MicButton } from './MicButton.js';

const toggle = vi.fn(async () => undefined);

function setVoice(enabled: boolean): void {
  useUiStore.setState({ ui: { ...DEFAULT_UI, voice: { enabled, model: enabled ? 'small' : null, language: 'auto' } } });
}

beforeEach(() => {
  toggle.mockClear();
  useDictationStore.setState({ phase: 'idle', targetId: null, level: 0, startedAt: null, toggle });
});
afterEach(cleanup);

describe('MicButton (спека 3.2)', () => {
  it('голос не настроен — тусклая, «Set up voice input», клик идёт в toggle (он откроет настройки)', () => {
    setVoice(false);
    render(<MicButton targetId="room" />);
    const button = screen.getByRole('button', { name: S.voice.setUp });
    expect(screen.getByTestId('mic').dataset.state).toBe('setup');
    fireEvent.click(button);
    expect(toggle).toHaveBeenCalledWith('room');
  });

  it('готово — «Dictate (⌘⇧M)»; mousedown не уводит фокус из поля', () => {
    setVoice(true);
    render(<MicButton targetId="room" />);
    const button = screen.getByRole('button', { name: S.voice.dictate });
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    button.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
  });

  it('запись своей цели — «Stop dictation», полоска громкости и таймер', () => {
    setVoice(true);
    useDictationStore.setState({ phase: 'recording', targetId: 'room', level: 0.05, startedAt: Date.now() - 7_000 });
    render(<MicButton targetId="room" />);
    expect(screen.getByRole('button', { name: S.voice.stop })).toBeTruthy();
    expect(screen.getByTestId('mic').dataset.state).toBe('recording');
    expect(screen.getByTestId('mic-elapsed').textContent).toBe('0:07');
  });

  it('запись чужой цели — своя кнопка готова; распознавание — все кнопки недоступны', () => {
    setVoice(true);
    useDictationStore.setState({ phase: 'recording', targetId: 'chat', startedAt: Date.now() });
    const { rerender } = render(<MicButton targetId="room" />);
    expect(screen.getByTestId('mic').dataset.state).toBe('ready');
    useDictationStore.setState({ phase: 'transcribing', targetId: 'chat' });
    rerender(<MicButton targetId="room" />);
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('распознавание своей цели — спиннер и «Transcribing…»', () => {
    setVoice(true);
    useDictationStore.setState({ phase: 'transcribing', targetId: 'room' });
    render(<MicButton targetId="room" />);
    expect(screen.getByTestId('mic').dataset.state).toBe('transcribing');
    expect(screen.getByText(S.voice.transcribing)).toBeTruthy();
  });

  it('formatElapsed', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(65_400)).toBe('1:05');
  });
});
