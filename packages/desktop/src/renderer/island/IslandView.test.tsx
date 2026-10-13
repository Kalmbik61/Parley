/**
 * Вид острова: пилюля и «×», список «в работе», карточка разрешения и вопроса, стрелки очереди, «Open in Parley»,
 * пометки, подсказка первого показа и отступ под чёлку, пауза кнопок решения после показа запроса (таймеры подставные).
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedCard } from '@parley/core';
import type { IslandApi } from '../../shared/island.js';
import type { IslandModel } from './model.js';
import type { IslandRequest } from './requests.js';
import { CARD_ARM_MS, IslandView, type IslandViewProps } from './IslandView.js';

const REF = { projectPath: '/tmp/proj', workId: 'w-1', sessionId: 's-02' };
const LABELS = new Map([['k', { session: 'S02 api', work: 'Backend', project: 'proj' }]]);

function api(): IslandApi {
  return {
    config: vi.fn(), onConfig: vi.fn(), setSize: vi.fn(), setVisible: vi.fn(), dragStart: vi.fn(), dragMove: vi.fn(),
    dragEnd: vi.fn(), open: vi.fn(), beep: vi.fn(), hintShown: vi.fn(),
  };
}

function permissionItem(patch: Partial<IslandRequest> = {}, suggestions: unknown[] = []): IslandRequest {
  const card = { id: 'c-1', at: '', kind: 'permission', cardId: 'c-1', state: 'pending', toolUseId: null, toolName: 'Bash', toolInput: { command: 'rm -rf build' }, suggestions, notified: false } as unknown as FeedCard;
  return { key: 'k\u0000c-1', ref: REF, card, summary: 'Run: rm -rf build', inWindow: true, since: 1, deciding: false, note: null, ...patch };
}

function questionItem(options: string[]): IslandRequest {
  const card = {
    id: 'c-3', at: '', kind: 'question', cardId: 'c-3', state: 'pending', toolUseId: null, toolName: 'AskUserQuestion', toolInput: {},
    questions: [{ question: 'Which DB?', header: null, multiSelect: false, options: options.map((label) => ({ label, description: null })) }],
  } as unknown as FeedCard;
  return permissionItem({ key: 'k\u0000c-3', card, summary: 'Question: Which DB?' });
}

const MODEL: IslandModel = {
  working: 2, waiting: 1, providers: ['claude'], active: true,
  groups: [{ key: 'g', title: 'Backend', project: 'proj', rows: [
    { kind: 'session', key: 'k', ref: REF, label: 'S02 api', provider: 'claude', state: 'needs-you', inTerminal: true },
    { kind: 'room', key: 'r', projectPath: '/tmp/proj', workId: 'w-1', roomId: 'r-1', title: 'Refunds', busy: 1 },
  ] }],
};

function viewProps(patch: Partial<IslandViewProps> = {}): IslandViewProps {
  return {
    model: MODEL, items: [], index: 0, config: { sound: true, hintShown: true, topInset: 0 }, listOpen: false,
    labels: LABELS, api: api(),
    onToggleList: vi.fn(), onHide: vi.fn(), onSelect: vi.fn(), onDecide: vi.fn(), onHintDone: vi.fn(),
    ...patch,
  };
}

/** Проходит паузу `CARD_ARM_MS`: после неё кнопки решения нажимаются. */
function arm(): void {
  act(() => {
    vi.advanceTimersByTime(CARD_ARM_MS);
  });
}

/** Рисует вид; `armed: false` — без прохода паузы кнопок решения (тест самой паузы). */
function view(patch: Partial<IslandViewProps> = {}, armed = true): IslandViewProps {
  const props = viewProps(patch);
  render(<IslandView {...props} />);
  if (armed) arm();
  return props;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('вид острова', () => {
  it('пилюля: счётчики и «×»', () => {
    const props = view();
    expect(screen.getByTestId('island-pill').textContent).toContain('2 working · 1 waiting');
    fireEvent.click(screen.getByRole('button', { name: 'Hide until the next request' }));
    expect(props.onHide).toHaveBeenCalled();
  });

  it('список: ждущая без карточки — «waiting in terminal», точки как в сайдбаре, клик по строке открывает её в Parley', () => {
    const props = view({ listOpen: true });
    expect(screen.getByText('waiting in terminal')).toBeTruthy();
    expect(screen.getAllByTestId('agent-state-dot').map((dot) => dot.getAttribute('data-state'))).toEqual(['blocked', 'working']);
    fireEvent.click(screen.getByText('S02 api'));
    expect(props.api.open).toHaveBeenCalledWith({ kind: 'session', ref: REF });
    fireEvent.click(screen.getByText('Refunds'));
    expect(props.api.open).toHaveBeenCalledWith({ kind: 'room', projectPath: '/tmp/proj', workId: 'w-1', roomId: 'r-1' });
  });

  it('карточка разрешения: шапка, суть, Allow и Deny; без правил — без Always', () => {
    const props = view({ items: [permissionItem()] });
    expect(screen.getByTestId('island-card').textContent).toContain('S02 api · Backend');
    expect(screen.getByTitle('Run: rm -rf build')).toBeTruthy();
    expect(screen.queryByTestId('island-always')).toBeNull();
    fireEvent.click(screen.getByTestId('island-allow'));
    expect(props.onDecide).toHaveBeenCalledWith('k\u0000c-1', { kind: 'permission', behavior: 'allow' });
    fireEvent.click(screen.getByTestId('island-deny'));
    expect(props.onDecide).toHaveBeenCalledWith('k\u0000c-1', { kind: 'permission', behavior: 'deny' });
  });

  it('правила есть — Always с подсказкой правил', () => {
    const props = view({ items: [permissionItem({}, [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'rm -rf build' }] }])] });
    expect(screen.getByTestId('island-always').getAttribute('title')).toBe('Bash(rm -rf build)');
    fireEvent.click(screen.getByTestId('island-always'));
    expect(props.onDecide).toHaveBeenCalledWith('k\u0000c-1', { kind: 'permission', behavior: 'allow', always: true });
  });

  it('простой вопрос — кнопки вариантов, ответ по тексту вопроса', () => {
    const props = view({ items: [questionItem(['Postgres', 'SQLite'])] });
    const buttons = screen.getAllByTestId('island-option');
    expect(buttons.map((button) => button.textContent)).toEqual(['Postgres', 'SQLite']);
    fireEvent.click(buttons[1] as HTMLElement);
    expect(props.onDecide).toHaveBeenCalledWith('k\u0000c-3', { kind: 'question', answers: { 'Which DB?': 'SQLite' } });
  });

  it('несколько запросов — «1 of 2» и стрелки', () => {
    const props = view({ items: [permissionItem(), permissionItem({ key: 'k\u0000c-2' })], index: 0 });
    expect(screen.getByText('1 of 2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next request' }));
    expect(props.onSelect).toHaveBeenCalledWith(1);
  });

  it('ответить из окна нельзя (Codex в терминале) или план — только Open in Parley с целью карточки', () => {
    const props = view({ items: [permissionItem({ inWindow: false })] });
    expect(screen.queryByTestId('island-allow')).toBeNull();
    fireEvent.click(screen.getByTestId('island-open'));
    expect(props.api.open).toHaveBeenCalledWith({ kind: 'session', ref: REF });
  });

  it('решается — кнопки выключены', () => {
    view({ items: [permissionItem({ deciding: true })] });
    expect((screen.getByTestId('island-allow') as HTMLButtonElement).disabled).toBe(true);
  });

  it('пометка «Answered elsewhere»', () => {
    view({ items: [permissionItem({ note: 'elsewhere' })] });
    expect(screen.getByText('Answered elsewhere')).toBeTruthy();
  });

  it('пометка «Couldn\'t send — try again»: кнопки снова нажимаются', () => {
    const props = view({ items: [permissionItem({ note: 'failed' })] });
    expect(screen.getByText("Couldn't send — try again")).toBeTruthy();
    fireEvent.click(screen.getByTestId('island-allow'));
    expect(props.onDecide).toHaveBeenCalledWith('k\u0000c-1', { kind: 'permission', behavior: 'allow' });
  });

  it('подсказка первого показа и отступ под чёлку', () => {
    const props = view({ config: { sound: true, hintShown: false, topInset: 38 } });
    expect(screen.getByText('Drag me · × to hide · turn off in Settings')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(props.onHintDone).toHaveBeenCalled();
    expect((screen.getByTestId('island') as HTMLElement).style.paddingTop).toBe('38px');
  });
});

describe('пауза кнопок решения после показа запроса', () => {
  it('сразу после показа Allow выключен, через 500 мс нажимается и зовёт onDecide', () => {
    const props = view({ items: [permissionItem()] }, false);
    const allow = screen.getByTestId('island-allow') as HTMLButtonElement;
    expect(allow.disabled).toBe(true);
    fireEvent.click(allow);
    expect(props.onDecide).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(CARD_ARM_MS - 1);
    });
    expect(allow.disabled).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(allow.disabled).toBe(false);
    fireEvent.click(allow);
    expect(props.onDecide).toHaveBeenCalledWith('k\u0000c-1', { kind: 'permission', behavior: 'allow' });
  });

  it('Always, Deny и варианты ответа тоже выключены до конца паузы', () => {
    view({ items: [permissionItem({}, [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls' }] }])] }, false);
    expect((screen.getByTestId('island-always') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('island-deny') as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    view({ items: [questionItem(['Postgres', 'SQLite'])] }, false);
    expect(screen.getAllByTestId('island-option').every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    arm();
    expect(screen.getAllByTestId('island-option').every((button) => !(button as HTMLButtonElement).disabled)).toBe(true);
  });

  it('«Open in Parley» и стрелки не защищены паузой', () => {
    const props = view({ items: [permissionItem({ inWindow: false }), permissionItem({ key: 'k\u0000c-2' })] }, false);
    fireEvent.click(screen.getByRole('button', { name: 'Next request' }));
    expect(props.onSelect).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getByTestId('island-open'));
    expect(props.api.open).toHaveBeenCalledWith({ kind: 'session', ref: REF });
  });

  it('новый запрос получает свою паузу, уже показанный дольше паузы — нет', () => {
    const props = viewProps({ items: [permissionItem(), permissionItem({ key: 'k\u0000c-2' })] });
    const { rerender } = render(<IslandView {...props} />);
    const allowDisabled = (): boolean => (screen.getByTestId('island-allow') as HTMLButtonElement).disabled;
    arm();
    expect(allowDisabled()).toBe(false);
    rerender(<IslandView {...props} index={1} />);
    expect(allowDisabled()).toBe(true);
    arm();
    expect(allowDisabled()).toBe(false);
    rerender(<IslandView {...props} index={0} />);
    expect(allowDisabled()).toBe(false);
  });
});
