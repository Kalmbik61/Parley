/**
 * Большой вид помощника: ответ и вопрос, подпись состояния, карточка подтверждения (кнопка Send взводится через
 * 500 мс, Enter в пустом поле отправляет), ввод по Enter, ошибка на карточке и строка ожидающих запросов; вопрос в пути,
 * очередь, упоминания на карточке и загрузка на Send.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantState } from '@parley/protocol';
import { AssistantView, type AssistantViewProps } from './AssistantView.js';
import { HOST_IDLE } from './store.js';

const PROPOSAL = { id: 'p1', target: 'Auth', where: 'Parley · Backend', kind: 'note', text: 'Please start with the tests.', wake: false } as const;

function props(patch: Partial<AssistantViewProps> = {}, host: Partial<AssistantState> = {}): AssistantViewProps {
  return {
    host: { ...HOST_IDLE, ...host },
    input: 'idle',
    level: 0,
    listenStartedAt: null,
    draft: '',
    notice: null,
    cardError: null,
    sending: null,
    queue: [],
    history: [],
    deciding: null,
    hotkey: 'Alt+Space',
    pending: null,
    maxHeight: 'calc(100vh - 88px)',
    onDraft: vi.fn(),
    onSubmit: vi.fn(),
    onMic: vi.fn(),
    onDecide: vi.fn(),
    onUnqueue: vi.fn(),
    onShowRequests: vi.fn(),
    ...patch,
  };
}

const submitForm = (): void => {
  fireEvent.submit(screen.getByTestId('assistant-input').closest('form')!);
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('вид помощника', () => {
  it('ответ и вопрос видны, подпись — из statusLabel', () => {
    render(<AssistantView {...props({}, { phase: 'answering', question: 'Who is working?', answer: 'Two agents.' })} />);
    expect(screen.getByText('Who is working?')).toBeTruthy();
    expect(screen.getByTestId('assistant-answer').textContent).toBe('Two agents.');
    expect(screen.getByTestId('assistant-status').textContent).toBe('Answering');
  });

  it('середина прокручивается в пределе maxHeight; без вопроса и ответа она пустая; вопрос — в две строки с подсказкой', () => {
    const question = 'Should this go to the busy room or to a new one? '.repeat(6).trim();
    const { rerender } = render(<AssistantView {...props()} />);
    expect(screen.getByTestId('assistant-view').style.maxHeight).toBe('calc(100vh - 88px)');
    expect(screen.getByTestId('assistant-scroll').childElementCount).toBe(0);
    rerender(<AssistantView {...props({}, { phase: 'answering', question, answer: 'Two agents.' })} />);
    const scroll = screen.getByTestId('assistant-scroll');
    expect(scroll.className).toContain('overflow-y-auto');
    expect(scroll.contains(screen.getByTestId('assistant-answer'))).toBe(true);
    const shown = screen.getByTitle(question);
    expect(shown.className).toContain('line-clamp-2');
  });

  it('карточка: адресат и текст; Send выключена первые 500 мс, потом зовёт onDecide', () => {
    const p = props({}, { phase: 'awaiting-confirm', proposal: PROPOSAL });
    render(<AssistantView {...p} />);
    const card = screen.getByTestId('assistant-card');
    expect(card.textContent).toContain('To');
    expect(card.textContent).toContain('Auth');
    expect(card.textContent).toContain('Please start with the tests.');
    const send = screen.getByTestId('assistant-send') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    expect(p.onDecide).toHaveBeenCalledWith('send');
  });

  it('Enter в пустом поле при карточке отправляет её (после взвода)', () => {
    const p = props({}, { phase: 'awaiting-confirm', proposal: PROPOSAL });
    render(<AssistantView {...p} />);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    submitForm();
    expect(p.onDecide).toHaveBeenCalledWith('send');
    expect(p.onSubmit).not.toHaveBeenCalled();
  });

  it('Enter в поле с текстом зовёт onSubmit', () => {
    const p = props({ draft: 'who is working?' });
    render(<AssistantView {...p} />);
    submitForm();
    expect(p.onSubmit).toHaveBeenCalledWith('who is working?');
  });

  it('карточка спящей сессии: подпись про пробуждение и кнопка «Wake and send»', () => {
    const p = props({}, { phase: 'awaiting-confirm', proposal: { ...PROPOSAL, target: 'S03 Ruslan', kind: null, wake: true } });
    render(<AssistantView {...p} />);
    expect(screen.getByTestId('assistant-wake-note').textContent).toBe('The agent is asleep and will be woken with this message.');
    const send = screen.getByTestId('assistant-send') as HTMLButtonElement;
    expect(send.textContent).toBe('Wake and send');
    act(() => {
      vi.advanceTimersByTime(500);
    });
    fireEvent.click(send);
    expect(p.onDecide).toHaveBeenCalledWith('send');
  });

  it('карточка без пробуждения: ни подписи, ни кнопки «Wake and send»', () => {
    render(<AssistantView {...props({}, { phase: 'awaiting-confirm', proposal: PROPOSAL })} />);
    expect(screen.queryByTestId('assistant-wake-note')).toBeNull();
    expect(screen.getByTestId('assistant-send').textContent).toBe('Send');
  });

  it('cardError показывается на карточке', () => {
    render(<AssistantView {...props({ cardError: 'S03 is not running' }, { phase: 'awaiting-confirm', proposal: PROPOSAL })} />);
    expect(screen.getByTestId('assistant-card').textContent).toContain('S03 is not running');
  });

  it('точка статуса: error — коралловая, offline и confirm — свои цвета; рой есть в виде', () => {
    const { rerender } = render(<AssistantView {...props({}, { phase: 'error', error: 'Limit reached' })} />);
    expect((screen.getByTestId('assistant-status-dot') as HTMLElement).style.backgroundColor).toBe('rgb(220, 96, 76)');
    expect(screen.getByTestId('swarm')).toBeTruthy();
    rerender(<AssistantView {...props({}, { phase: 'offline', error: 'No CLI' })} />);
    expect((screen.getByTestId('assistant-status-dot') as HTMLElement).style.backgroundColor).toBe('rgb(156, 148, 138)');
    rerender(<AssistantView {...props({}, { phase: 'awaiting-confirm', proposal: PROPOSAL })} />);
    expect((screen.getByTestId('assistant-status-dot') as HTMLElement).style.backgroundColor).toBe('rgb(255, 194, 77)');
  });

  it('точка статуса пульсирует только при записи', () => {
    const { rerender } = render(<AssistantView {...props({ input: 'listening' })} />);
    expect(screen.getByTestId('assistant-status-dot').className).toContain('assistant-dot-pulse');
    rerender(<AssistantView {...props()} />);
    expect(screen.getByTestId('assistant-status-dot').className).not.toContain('assistant-dot-pulse');
  });

  it('строка ожидающих запросов по клику зовёт onShowRequests', () => {
    const p = props({ pending: { name: 'S02 api', total: 3 } });
    render(<AssistantView {...p} />);
    fireEvent.click(screen.getByTestId('assistant-pending'));
    expect(p.onShowRequests).toHaveBeenCalled();
  });

  it('запись: виден таймер и полоска громкости, кнопка — красная точка', () => {
    render(<AssistantView {...props({ input: 'listening', listenStartedAt: Date.now() - 65_000, level: 0.1 })} />);
    expect(screen.getByTestId('assistant-mic-elapsed').textContent).toBe('1:05');
    expect(screen.getByTestId('assistant-mic').getAttribute('aria-label')).toBe('Stop listening');
  });

  it('вопрос в пути: виден сразу, прошлый ответ и исход спрятаны, подпись — Sending…', () => {
    render(<AssistantView {...props({ sending: 'А комната?' }, { phase: 'idle', question: 'Кто работает?', answer: 'Двое.', outcome: 'sent' })} />);
    expect(screen.getByTestId('assistant-question').textContent).toBe('А комната?');
    expect(screen.queryByTestId('assistant-answer')).toBeNull();
    expect(screen.queryByTestId('assistant-sent')).toBeNull();
    expect(screen.getByTestId('assistant-status').textContent).toBe('Sending…');
  });

  it('история: прошлые обмены приглушённо над текущим вопросом', () => {
    render(<AssistantView {...props({ history: [{ id: 1, question: 'Кто работает?', answer: 'Двое.' }] }, { phase: 'thinking', question: 'А комната?', turn: 2 })} />);
    const [exchange] = screen.getAllByTestId('assistant-history');
    expect(exchange!.textContent).toBe('Кто работает?Двое.');
    expect(screen.getByTestId('assistant-scroll').firstElementChild).toBe(exchange);
    expect(screen.getByTestId('assistant-question').textContent).toBe('А комната?');
  });

  it('вопрос в пути: текущий обмен уже приглушён в истории над ним', () => {
    render(<AssistantView {...props({ sending: 'А комната?' }, { question: 'Кто работает?', answer: 'Двое.', turn: 1 })} />);
    expect(screen.getAllByTestId('assistant-history').map((item) => item.textContent)).toEqual(['Кто работает?Двое.']);
    expect(screen.getByTestId('assistant-question').textContent).toBe('А комната?');
  });

  it('поле не принимает больше 4000 знаков', () => {
    render(<AssistantView {...props()} />);
    expect((screen.getByTestId('assistant-input') as HTMLInputElement).maxLength).toBe(4000);
  });

  it('очередь: серые Queued внизу середины, × убирает', () => {
    const p = props({ queue: [{ id: 1, text: 'и ещё одно' }, { id: 2, text: 'и третье' }] }, { phase: 'answering', question: 'q', answer: 'a' });
    render(<AssistantView {...p} />);
    const queued = screen.getAllByTestId('assistant-queued');
    expect(queued.map((item) => item.textContent)).toEqual(['и ещё одноQueued', 'и третьеQueued']);
    expect(screen.getByTestId('assistant-scroll').lastElementChild).toBe(queued[1]);
    fireEvent.click(screen.getAllByLabelText('Remove from queue')[1]!);
    expect(p.onUnqueue).toHaveBeenCalledWith(2);
  });

  it('упомянутые — чипами @ впереди текста карточки', () => {
    render(<AssistantView {...props({}, { phase: 'awaiting-confirm', proposal: { ...PROPOSAL, mentions: ['S03 Ruslan', 'S05 Vera'] } })} />);
    expect(screen.getAllByTestId('assistant-mention').map((chip) => chip.textContent)).toEqual(['@S03 Ruslan', '@S05 Vera']);
  });

  it('решение в пути: Send крутится, обе кнопки выключены, Enter в пустом поле не шлёт второй раз', () => {
    const p = props({ deciding: 'send' }, { phase: 'awaiting-confirm', proposal: PROPOSAL });
    render(<AssistantView {...p} />);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByTestId('assistant-send-spinner')).toBeTruthy();
    expect((screen.getByTestId('assistant-send') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('assistant-cancel') as HTMLButtonElement).disabled).toBe(true);
    submitForm();
    expect(p.onDecide).not.toHaveBeenCalled();
  });

  it('распознавание: кнопка микрофона выключена, таймера нет', () => {
    render(<AssistantView {...props({ input: 'transcribing' })} />);
    expect((screen.getByTestId('assistant-mic') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId('assistant-mic-elapsed')).toBeNull();
  });
});
