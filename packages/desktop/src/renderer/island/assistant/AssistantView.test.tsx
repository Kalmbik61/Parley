/**
 * Большой вид помощника: ответ и вопрос, подпись состояния, карточка подтверждения (кнопка Send взводится через
 * 500 мс, Enter в пустом поле отправляет), ввод по Enter, ошибка на карточке и строка ожидающих запросов; вопрос в пути,
 * очередь, упоминания на карточке и загрузка на Send. Речь (план 3 Task 9, план 3b B24): лицо с эмоцией звучащего
 * предложения, «Done» после речи, значок динамика, кадр голоса — в цикле кадров роя, реакция и «Reduce motion» — в рой.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantProposal, AssistantState } from '@parley/protocol';
import { S } from '../../../shared/strings.js';
import * as engineModule from '../swarm/engine.js';
import { AssistantView, type AssistantViewProps } from './AssistantView.js';
import { HOST_IDLE } from './store.js';
import type { VoiceFrame } from './voice-features.js';

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
    sentenceMood: null,
    speakOn: false,
    maxHeight: 'calc(100vh - 88px)',
    onDraft: vi.fn(),
    onSubmit: vi.fn(),
    onMic: vi.fn(),
    onDecide: vi.fn(),
    onTakeKeyboard: vi.fn(),
    onUnqueue: vi.fn(),
    onShowRequests: vi.fn(),
    onToggleSpeak: vi.fn(),
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

  it('касание поля ввода забирает клавиатуру у острова, открытого сам', () => {
    const p = props();
    render(<AssistantView {...p} />);
    fireEvent.pointerDown(screen.getByTestId('assistant-input'));
    expect(p.onTakeKeyboard).toHaveBeenCalled();
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

  describe('карточка actions (руки помощника)', () => {
    const ACTIONS = {
      action: 'actions',
      id: 'p7',
      target: '2 steps',
      where: 'Parley · my_harnas',
      text: 'Update Parley to confirm this card.',
      steps: [
        { verb: 'sleep', line: 'Put S03 Ruslan to sleep', text: null, danger: false },
        { verb: 'close', line: 'Close S05 Vera for good', text: null, danger: true },
      ],
    } as const;
    const oneStep = (verb: 'create_work' | 'create_session' | 'create_room' | 'wake' | 'interrupt' | 'sleep' | 'close' | 'add_to_room' | 'message'): AssistantProposal => ({
      ...ACTIONS,
      steps: [{ verb, line: 'a step', text: null, danger: verb === 'close' }],
    });

    it('карточка шагов: строки, предупреждение у close, «Do all (2)»', () => {
      show(ACTIONS);
      expect(screen.getAllByTestId('assistant-step').map((el) => el.textContent)).toEqual([expect.stringContaining('Put S03 Ruslan to sleep'), expect.stringContaining('closes for good')]);
      expect(screen.getByTestId('assistant-steps').tagName).toBe('OL');
      expect(screen.getByTestId('assistant-send').textContent).toContain('Do all (2)');
    });

    it('текст общего вида карточки (для старого окна) не рисуется, только шаги', () => {
      show(ACTIONS);
      expect(screen.getByTestId('assistant-card').textContent).not.toContain('Update Parley to confirm this card.');
    });

    it('шаг без danger не получает «closes for good»', () => {
      show(ACTIONS);
      const [first] = screen.getAllByTestId('assistant-step');
      expect(first!.textContent).not.toContain('closes for good');
    });

    it('один шаг: глагол шага на кнопке', () => {
      const labels: Array<[Parameters<typeof oneStep>[0], string]> = [
        ['create_work', 'Create'],
        ['create_session', 'Create'],
        ['create_room', 'Create'],
        ['wake', 'Wake'],
        ['interrupt', 'Stop'],
        ['sleep', 'Put to sleep'],
        ['close', 'Close'],
        ['add_to_room', 'Add'],
        ['message', 'Send'],
      ];
      for (const [verb, label] of labels) {
        const { unmount } = render(<AssistantView {...props({}, { phase: 'awaiting-confirm', proposal: oneStep(verb) })} />);
        expect(screen.getByTestId('assistant-send').textContent, verb).toBe(label);
        unmount();
      }
    });

    it('текст шага — в рамке с акцентной полосой, у шага без текста рамки нет', () => {
      show({ ...ACTIONS, steps: [{ verb: 'message', line: 'Message S03 Ruslan', text: 'Please start with the tests.', danger: false }, { verb: 'wake', line: 'Wake S05 Vera', text: null, danger: false }] });
      const [first, second] = screen.getAllByTestId('assistant-step');
      expect(first!.querySelector('.border-l-2')!.textContent).toBe('Please start with the tests.');
      expect(second!.querySelector('.border-l-2')).toBeNull();
    });

    it('Enter в пустом поле не подтверждает карточку actions; подсказка — «Confirm with the button»', () => {
      const onDecide = vi.fn();
      render(<AssistantView {...props({ onDecide }, { phase: 'awaiting-confirm', proposal: ACTIONS })} />);
      act(() => {
        vi.advanceTimersByTime(500);
      });
      submitForm();
      expect(onDecide).not.toHaveBeenCalled();
      expect(screen.getByTestId('assistant-card').textContent).toContain('Confirm with the button');
      expect(screen.getByTestId('assistant-card').textContent).not.toContain('Enter to send');
    });

    it('кнопка карточки actions подтверждает после взвода', () => {
      const onDecide = vi.fn();
      render(<AssistantView {...props({ onDecide }, { phase: 'awaiting-confirm', proposal: ACTIONS })} />);
      act(() => {
        vi.advanceTimersByTime(500);
      });
      fireEvent.click(screen.getByTestId('assistant-send'));
      expect(onDecide).toHaveBeenCalledWith('send');
    });

    it('отчёт: остановка на шаге и пометки', () => {
      render(
        <AssistantView
          {...props(
            {},
            {
              outcome: 'done',
              report: {
                proposalId: 'p7',
                status: 'stopped',
                steps: [
                  { line: 'a', status: 'done' },
                  { line: 'b', status: 'failed' },
                ],
                failedStep: 2,
                reason: 'S05 Vera is already asleep',
                notes: ['Alice waits for you to trust the folder'],
              },
            },
          )}
        />,
      );
      const report = screen.getByTestId('assistant-report');
      expect(report.textContent).toContain('Stopped at step 2 of 2: S05 Vera is already asleep');
      expect(report.textContent).toContain('Alice waits for you to trust the folder');
      expect(screen.queryByTestId('assistant-done')).toBeNull();
    });

    it('отчёт: значки статусов шагов', () => {
      render(
        <AssistantView
          {...props(
            {},
            {
              report: {
                proposalId: 'p7',
                status: 'running',
                steps: [
                  { line: 'a', status: 'done' },
                  { line: 'b', status: 'running' },
                  { line: 'c', status: 'waiting' },
                  { line: 'd', status: 'failed' },
                  { line: 'e', status: 'skipped' },
                ],
                failedStep: null,
                reason: null,
                notes: [],
              },
            },
          )}
        />,
      );
      const lines = screen.getAllByTestId('assistant-report-step').map((el) => el.textContent);
      expect(lines).toEqual(['✓a', '…b', 'c', '✗d', '–e'].map((text) => expect.stringContaining(text)));
      expect(screen.getByTestId('assistant-report').textContent).toContain('Running step 2 of 5');
    });

    it('отчёт о завершённом плане заменяет «Done ✓»', () => {
      render(<AssistantView {...props({}, { outcome: 'done', report: { proposalId: 'p7', status: 'done', steps: [{ line: 'a', status: 'done' }], failedStep: null, reason: null, notes: [] } })} />);
      expect(screen.getByTestId('assistant-report').textContent).toContain('Done');
      expect(screen.queryByTestId('assistant-done')).toBeNull();
    });

    it('пока есть карточка, отчёта нет; без отчёта (старый хост) — «Done ✓» как раньше', () => {
      render(<AssistantView {...props({}, { outcome: 'done' })} />);
      expect(screen.queryByTestId('assistant-report')).toBeNull();
      expect(screen.getByTestId('assistant-done')).toBeTruthy();
      cleanup();
      render(<AssistantView {...props({}, { phase: 'awaiting-confirm', proposal: ACTIONS, report: { proposalId: 'p6', status: 'done', steps: [{ line: 'a', status: 'done' }], failedStep: null, reason: null, notes: [] } })} />);
      expect(screen.queryByTestId('assistant-report')).toBeNull();
    });
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

describe('речь: лицо, значок динамика, кадр голоса (план 3 Task 9, план 3b B24)', () => {
  const VOICE: VoiceFrame = { amp: 0.7, visemes: { a: 0.5, i: 0, u: 0, m: 0 } };

  /** Движки роёв вида и шпионы их `setSpec` и `react`: шпион ставится при создании, до первого эффекта. */
  function spyEngines(): Array<{ setSpec: ReturnType<typeof vi.fn>; react: ReturnType<typeof vi.fn> }> {
    const real = engineModule.createSwarm;
    const engines: Array<{ setSpec: ReturnType<typeof vi.fn>; react: ReturnType<typeof vi.fn> }> = [];
    vi.spyOn(engineModule, 'createSwarm').mockImplementation((...args) => {
      const engine = real(...args);
      engines.push({ setSpec: vi.spyOn(engine, 'setSpec') as unknown as ReturnType<typeof vi.fn>, react: vi.spyOn(engine, 'react') as unknown as ReturnType<typeof vi.fn> });
      return engine;
    });
    return engines;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('speaking и mood sad: лицо sad и «Speaking»; settling — сфера и «Done»', () => {
    const { rerender } = render(<AssistantView {...props({ input: 'speaking' }, { mood: 'sad' })} />);
    const canvas = screen.getByTestId('swarm');
    expect(canvas.getAttribute('data-shape')).toBe('face');
    expect(canvas.getAttribute('data-emo')).toBe('sad');
    expect(screen.getByTestId('assistant-status').textContent).toBe('Speaking');
    rerender(<AssistantView {...props({ input: 'settling' }, { mood: 'sad' })} />);
    expect(screen.getByTestId('swarm').getAttribute('data-shape')).toBe('sphere');
    expect(screen.getByTestId('swarm').getAttribute('data-emo')).toBeNull();
    expect(screen.getByTestId('assistant-status').textContent).toBe('Done');
  });

  it('data-emo идёт за эмоцией звучащего предложения, а не за меткой хода (L3)', () => {
    const { rerender } = render(<AssistantView {...props({ input: 'speaking', sentenceMood: 'anger' }, { mood: 'joy' })} />);
    expect(screen.getByTestId('swarm').getAttribute('data-emo')).toBe('anger');
    rerender(<AssistantView {...props({ input: 'speaking', sentenceMood: 'sad' }, { mood: 'joy' })} />);
    expect(screen.getByTestId('swarm').getAttribute('data-emo')).toBe('sad');
    rerender(<AssistantView {...props({ input: 'speaking', sentenceMood: null }, { mood: 'joy' })} />);
    expect(screen.getByTestId('swarm').getAttribute('data-emo')).toBe('joy');
  });

  it('значок динамика: подпись «Speak answers», aria-pressed по настройке, клик зовёт onToggleSpeak, фокус не уходит', () => {
    const p = props({ speakOn: true });
    const { rerender } = render(<AssistantView {...p} />);
    const button = screen.getByTestId('assistant-speak');
    expect(button.getAttribute('aria-label')).toBe(S.assistant.settings.speak);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(fireEvent.mouseDown(button)).toBe(false);
    fireEvent.click(button);
    expect(p.onToggleSpeak).toHaveBeenCalledTimes(1);
    rerender(<AssistantView {...props({ speakOn: false })} />);
    expect(screen.getByTestId('assistant-speak').getAttribute('aria-pressed')).toBe('false');
  });

  it('строка G3: голос не скачан — подсказка видна в середине вида', () => {
    render(<AssistantView {...props({ notice: S.assistant.voiceMissing('Serena') }, { answer: 'Two agents.' })} />);
    expect(screen.getByTestId('assistant-scroll').textContent).toContain('Voice "Serena" isn\'t downloaded — open Settings');
  });

  it('кадр голоса: геттер voice читается в кадре роя (подставной rAF), не при рендере', () => {
    const ctx = {
      setTransform: vi.fn(), clearRect: vi.fn(), drawImage: vi.fn(), fillRect: vi.fn(), fillStyle: '', globalAlpha: 1, globalCompositeOperation: '',
      createRadialGradient: () => ({ addColorStop: vi.fn() }),
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    let frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      frames.push(cb);
      return frames.length;
    });
    const voice = vi.fn(() => VOICE);
    const { rerender } = render(<AssistantView {...props({ input: 'speaking', voice }, { mood: 'joy' })} />);
    rerender(<AssistantView {...props({ input: 'speaking', voice, draft: 'a' }, { mood: 'joy' })} />);
    expect(voice).not.toHaveBeenCalled();
    for (let t = 100; t < 200; t += 16) {
      const run = frames;
      frames = [];
      for (const cb of run) cb(t);
    }
    expect(voice).toHaveBeenCalled();
  });

  it('реакция pulse уходит в движок большого роя один раз на событие', () => {
    const engines = spyEngines();
    vi.spyOn(performance, 'now').mockReturnValue(1000);
    const pulse = { reaction: 'glint', at: 1000 } as const;
    const { rerender } = render(<AssistantView {...props({ pulse }, { phase: 'tool' })} />);
    rerender(<AssistantView {...props({ pulse: { ...pulse } }, { phase: 'tool' })} />);
    expect(engines).toHaveLength(1);
    expect(engines[0]!.react).toHaveBeenCalledTimes(1);
    expect(engines[0]!.react).toHaveBeenCalledWith('glint', 1000, 1000, false);
  });

  it('«Reduce motion» Parley доходит до роя и лица: облик ставится без перехода', () => {
    const engines = spyEngines();
    render(<AssistantView {...props({ input: 'speaking', reducedMotion: true }, { mood: 'joy' })} />);
    expect(engines[0]!.setSpec).toHaveBeenCalledWith(expect.objectContaining({ shape: 'face', emo: 'joy' }), expect.any(Number), true);
  });
});
