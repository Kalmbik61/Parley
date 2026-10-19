/**
 * Большой вид помощника: ответ и вопрос, подпись состояния, карточка подтверждения (кнопка Send взводится через
 * 500 мс, Enter в пустом поле отправляет), ввод по Enter, ошибка на карточке и строка ожидающих запросов; вопрос в пути,
 * очередь, упоминания на карточке и загрузка на Send.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantProposal, AssistantState } from '@parley/protocol';
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

describe('карточки по action', () => {
  const BASE = { id: 'p2', target: 'S03 Ruslan', where: 'Parley · Backend', text: 'text' } as const;
  const show = (proposal: AssistantProposal, host: Partial<AssistantState> = {}): void => {
    render(<AssistantView {...props({}, { phase: 'awaiting-confirm', proposal, ...host })} />);
  };

  it('room: заголовок, строка участников, задача и кнопка Create (testid тот же)', () => {
    show({ ...BASE, action: 'room', title: 'Auth', members: ['S01 Ann', 'S03 Ruslan'], lead: 'S01 Ann', task: 'Split the login work.' });
    const card = screen.getByTestId('assistant-card');
    expect(card.textContent).toContain('New room in');
    expect(card.textContent).toContain('Parley · Backend');
    expect(screen.getByTestId('assistant-room-line').textContent).toBe('Auth · S01 Ann, S03 Ruslan · lead S01 Ann');
    expect(card.textContent).toContain('Split the login work.');
    expect(screen.getByTestId('assistant-send').textContent).toBe('Create');
    expect(screen.getByTestId('assistant-cancel')).toBeTruthy();
  });

  it('room без задачи не рисует блок задачи', () => {
    show({ ...BASE, action: 'room', title: 'Auth', members: ['S01 Ann'], lead: 'S01 Ann', task: null });
    expect(screen.getByTestId('assistant-card').querySelector('.border-l-2')).toBeNull();
  });

  it('decision: allow + always — заголовок, суть, подробности в pre и кнопка «Allow, don\'t ask again»', () => {
    show({
      ...BASE,
      action: 'decision',
      card: { cardId: 'c-1', kind: 'permission', summary: 'Run a shell command', detail: 'rm -rf build' },
      decision: { kind: 'permission', behavior: 'allow', always: true },
    });
    expect(screen.getByTestId('assistant-card-title').textContent).toBe('Allow S03 Ruslan?');
    expect(screen.getByTestId('assistant-card').textContent).toContain('Run a shell command');
    const detail = screen.getByTestId('assistant-card-detail');
    expect(detail.tagName).toBe('PRE');
    expect(detail.textContent).toBe('rm -rf build');
    expect(detail.className).toContain('max-h-40');
    expect(screen.getByTestId('assistant-send').textContent).toBe("Allow, don't ask again");
  });

  it('decision: deny, question и plan — подписи кнопок и глаголы заголовка', () => {
    const card = { cardId: 'c-1', kind: 'permission', summary: 's', detail: null } as const;
    const { rerender } = render(<AssistantView {...props({}, { phase: 'awaiting-confirm', proposal: { ...BASE, action: 'decision', card, decision: { kind: 'permission', behavior: 'deny' } } })} />);
    expect(screen.getByTestId('assistant-card-title').textContent).toBe('Deny S03 Ruslan?');
    expect(screen.getByTestId('assistant-send').textContent).toBe('Deny');
    expect(screen.queryByTestId('assistant-card-detail')).toBeNull();
    rerender(<AssistantView {...props({}, { phase: 'awaiting-confirm', proposal: { ...BASE, id: 'p3', action: 'decision', card, decision: { kind: 'question', answers: { q1: 'Yes' } } } })} />);
    expect(screen.getByTestId('assistant-send').textContent).toBe('Answer');
    expect(screen.getByTestId('assistant-card-title').textContent).toBe('Answer S03 Ruslan?');
    rerender(<AssistantView {...props({}, { phase: 'awaiting-confirm', proposal: { ...BASE, id: 'p4', action: 'decision', card, decision: { kind: 'plan', choice: 'manual' } } })} />);
    expect(screen.getByTestId('assistant-send').textContent).toBe('Approve each edit');
    expect(screen.getByTestId('assistant-card-title').textContent).toBe('Approve each edit of S03 Ruslan?');
    rerender(<AssistantView {...props({}, { phase: 'awaiting-confirm', proposal: { ...BASE, id: 'p5', action: 'decision', card, decision: { kind: 'plan', choice: 'auto-accept' } } })} />);
    expect(screen.getByTestId('assistant-send').textContent).toBe('Accept plan');
    expect(screen.getByTestId('assistant-card-title').textContent).toBe('Accept plan of S03 Ruslan?');
  });

  it('карточка вопроса показывает выбранные ответы по строке; у разрешения строк ответов нет', () => {
    const card = { cardId: 'c-1', kind: 'question', summary: 's', detail: null } as const;
    const { rerender } = render(
      <AssistantView {...props({}, { phase: 'awaiting-confirm', proposal: { ...BASE, action: 'decision', card, decision: { kind: 'question', answers: { 'Which db?\nsecond line': 'Postgres', 'Why?': 'Because' } } } })} />,
    );
    const lines = screen.getAllByTestId('assistant-card-answer');
    expect(lines.map((line) => line.textContent)).toEqual(['Which db? → Postgres', 'Why? → Because']);
    rerender(<AssistantView {...props({}, { phase: 'awaiting-confirm', proposal: { ...BASE, id: 'p9', action: 'decision', card, decision: { kind: 'permission', behavior: 'allow' } } })} />);
    expect(screen.queryByTestId('assistant-card-answer')).toBeNull();
  });

  it('room-decision return: заголовок с ведущим, текст и «Note: …»; accept — заголовок с комнатой', () => {
    const proposal = { proposalId: 'rp-1', rev: 1, kind: 'decision', from: 'S01 Ruslan', text: 'Use a queue.' } as const;
    const { rerender } = render(<AssistantView {...props({}, { phase: 'awaiting-confirm', proposal: { ...BASE, target: 'Auth', action: 'room-decision', proposal, choice: 'return', note: 'Add tests first.' } })} />);
    expect(screen.getByTestId('assistant-card-title').textContent).toBe('Return to S01 Ruslan for rework?');
    expect(screen.getByTestId('assistant-card').textContent).toContain('Use a queue.');
    expect(screen.getByTestId('assistant-card').textContent).toContain('Note: Add tests first.');
    expect(screen.getByTestId('assistant-send').textContent).toBe('Return');
    rerender(<AssistantView {...props({}, { phase: 'awaiting-confirm', proposal: { ...BASE, id: 'p6', target: 'Auth', action: 'room-decision', proposal, choice: 'accept', note: null } })} />);
    expect(screen.getByTestId('assistant-card-title').textContent).toBe('Accept decision in Auth?');
    expect(screen.getByTestId('assistant-send').textContent).toBe('Accept');
    expect(screen.getByTestId('assistant-card').textContent).not.toContain('Note:');
  });

  it('room-decision обрезает текст предложения до 1500 знаков', () => {
    const proposal = { proposalId: 'rp-1', rev: 1, kind: 'decision', from: 'S01 Ruslan', text: 'x'.repeat(2000) } as const;
    show({ ...BASE, target: 'Auth', action: 'room-decision', proposal, choice: 'accept', note: null });
    expect(screen.getByTestId('assistant-card').textContent).toContain('x'.repeat(1500));
    expect(screen.getByTestId('assistant-card').textContent).not.toContain('x'.repeat(1501));
  });

  it('room-decision с текстом длиннее 1500 знаков кончается многоточием, короткий — без него', () => {
    const base = { proposalId: 'rp-1', rev: 1, kind: 'decision', from: 'S01 Ruslan' } as const;
    const { rerender } = render(<AssistantView {...props({}, { phase: 'awaiting-confirm', proposal: { ...BASE, target: 'Auth', action: 'room-decision', proposal: { ...base, text: 'y'.repeat(1600) }, choice: 'accept', note: null } })} />);
    expect(screen.getByTestId('assistant-card').textContent).toContain(`${'y'.repeat(1500)}…`);
    rerender(<AssistantView {...props({}, { phase: 'awaiting-confirm', proposal: { ...BASE, id: 'p8', target: 'Auth', action: 'room-decision', proposal: { ...base, text: 'short' }, choice: 'accept', note: null } })} />);
    expect(screen.getByTestId('assistant-card').textContent).not.toContain('…');
  });

  it('карточка без action (старый хост) — письмо с кнопкой Send', () => {
    show({ id: 'p7', target: 'Auth', where: 'Parley · Backend', text: 'Please start with the tests.', kind: null, wake: false });
    expect(screen.getByTestId('assistant-card').textContent).toContain('Please start with the tests.');
    expect(screen.getByTestId('assistant-send').textContent).toBe('Send');
  });

  it('outcome done показывает «Done ✓»; ошибка карточки остаётся на карточке', () => {
    const { rerender } = render(<AssistantView {...props({}, { outcome: 'done' })} />);
    expect(screen.getByTestId('assistant-done').textContent).toBe('Done ✓');
    expect(screen.queryByTestId('assistant-outcome-note')).toBeNull();
    rerender(<AssistantView {...props({ cardError: 'Already answered' }, { phase: 'awaiting-confirm', proposal: { ...BASE, action: 'room', title: 'Auth', members: ['S01 Ann'], lead: 'S01 Ann', task: null } })} />);
    expect(screen.getByTestId('assistant-card').textContent).toContain('Already answered');
    expect(screen.queryByTestId('assistant-outcome-note')).toBeNull();
  });

  it('карточку закрыл хост (cancelled) — причина видна рядом с итогом', () => {
    render(<AssistantView {...props({ cardError: 'Already answered' }, { outcome: 'cancelled', proposal: null })} />);
    expect(screen.getByTestId('assistant-outcome-note').textContent).toBe('Already answered');
    expect(screen.getByText('Cancelled')).toBeTruthy();
  });

  it('outcome done с причиной — заметка рядом с «Done ✓»', () => {
    render(<AssistantView {...props({ cardError: 'Room created, but the task was not sent' }, { outcome: 'done', proposal: null })} />);
    expect(screen.getByTestId('assistant-done').textContent).toBe('Done ✓');
    expect(screen.getByTestId('assistant-outcome-note').textContent).toBe('Room created, but the task was not sent');
  });

  it('Enter в пустом поле подтверждает карточку не-письма', () => {
    const onDecide = vi.fn();
    render(<AssistantView {...props({ onDecide }, { phase: 'awaiting-confirm', proposal: { ...BASE, action: 'room', title: 'Auth', members: ['S01 Ann'], lead: 'S01 Ann', task: null } })} />);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    submitForm();
    expect(onDecide).toHaveBeenCalledWith('send');
  });
});
