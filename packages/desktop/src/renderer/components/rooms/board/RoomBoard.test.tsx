/**
 * Доска комнаты (спека доски комнаты 4.1–4.3): колонки по режиму плана, строки карточки, уведомление, фильтр.
 * Модель проверяет `room-board-model.test.ts`; здесь — разметка.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { PlanAttempt, PlanItem, PlanMode, Room, RoomPlan, WindowWorkEntry, WorkSession } from '@parley/core';
import { S } from '../../../../shared/strings.js';
import { autonomousPlan } from '../../../test-utils/autonomous-plan.js';
import { activityMap, makeActivity, makeNeed, makeRoom, makeSession, makeWork } from '../../../test-utils/work-fixtures.js';
import { RoomBoard, type RoomBoardProps } from './RoomBoard.js';

afterEach(cleanup);

const NOW = new Date('2026-11-17T12:00:00.000Z');
const ref = (sessionId: string) => ({ projectPath: '/tmp/proj', workId: 'w-01', sessionId });

const item = (id: number, patch: Partial<PlanItem> = {}): PlanItem => ({
  id, title: `Item ${id}`, owner: 's-01', scope: 'src', after: [], criteria: [], verifier: 's-02', status: 'waiting', evidence: null, note: null, log: [], ...patch,
});
const planOf = (mode: PlanMode, items: PlanItem[], patch: Partial<RoomPlan> = {}): RoomPlan => ({
  id: 'pl-01', roomId: 'r-01', rev: 2, mode, status: 'active', goal: 'Goal', items, backlog: [],
  acceptedAt: 'x', completedAt: null, cancelledAt: null, completionSummary: null, ...patch,
});
const attempt = (patch: Partial<PlanAttempt>): PlanAttempt => ({ ...autonomousPlan().attempts[0]!, ...patch });
const autoPlan = (items: PlanItem[], attempts: PlanAttempt[], halted: unknown = null): RoomPlan =>
  planOf('autonomous', items, { autonomous: { ...autonomousPlan(), attempts, ops: [], halted } as never });

interface Setup { sessions?: WorkSession[]; room?: Partial<Room>; activity?: ReturnType<typeof makeActivity>[] }
function renderBoard(plan: RoomPlan, setup: Setup = {}, patch: Partial<RoomBoardProps> = {}) {
  const sessions = setup.sessions ?? [makeSession('s-01', 'back'), makeSession('s-02', 'front'), makeSession('s-03', 'lead')];
  const room: Room = { ...makeRoom('r-01', 'Delivery'), members: ['s-01', 's-02', 's-03'], lead: 's-03', ...setup.room };
  const entry: WindowWorkEntry = makeWork('w-01', { sessions, rooms: [room] });
  entry.map.plans = [plan];
  const props: RoomBoardProps = {
    plan, room, entry, participants: [], activity: activityMap(setup.activity ?? []), now: NOW, onOpenFeed: vi.fn(), ...patch,
  };
  return { ...render(<RoomBoard {...props} />), props };
}

const column = (id: string): HTMLElement => document.querySelector(`[data-board-column="${id}"]`) as HTMLElement;
const card = (id: number): HTMLElement => document.querySelector(`[data-board-item="${id}"]`) as HTMLElement;
const count = (id: string): string | null => column(id).querySelector('[data-board-count]')?.textContent ?? null;

describe('RoomBoard — колонки', () => {
  it('Verified: четыре колонки с числами, пункт стоит в своей колонке', () => {
    renderBoard(planOf('verified', [item(1), item(2, { status: 'in_progress' }), item(3, { status: 'in_progress' }), item(4, { status: 'done' }), item(5, { status: 'verified' })]));
    expect([...document.querySelectorAll('[data-board-column]')].map((el) => el.getAttribute('data-board-column'))).toEqual(['waiting', 'progress', 'review', 'done']);
    expect(['waiting', 'progress', 'review', 'done'].map(count)).toEqual(['1', '2', '1', '1']);
    expect(column('progress').contains(card(2))).toBe(true);
    expect(column('review').contains(card(4))).toBe(true);
    expect(within(column('done')).getByText(S.roomBoard.columns.verified)).toBeTruthy();
  });

  it('Checklist: три колонки, последняя — Done', () => {
    renderBoard(planOf('checklist', [item(1, { status: 'done' })]));
    expect([...document.querySelectorAll('[data-board-column]')].map((el) => el.getAttribute('data-board-column'))).toEqual(['waiting', 'progress', 'done']);
    expect(within(column('done')).getByText(S.roomBoard.columns.done)).toBeTruthy();
  });

  it('пустая колонка показывает Nothing here', () => {
    renderBoard(planOf('verified', [item(1)]));
    expect(within(column('review')).getByText(S.roomBoard.empty)).toBeTruthy();
    expect(within(column('waiting')).queryByText(S.roomBoard.empty)).toBeNull();
  });

  it('строка доски: состояние плана и его ход', () => {
    renderBoard(planOf('verified', [item(1, { status: 'verified' }), item(2)]));
    expect(document.querySelector('[data-room-board]')?.textContent).toContain(`${S.plans.status.active} · 1/2 verified`);
  });
});

describe('RoomBoard — карточка', () => {
  it('в работе: агент, слово состояния и чем он занят', () => {
    const progress = { owner: { by: 's-01', at: '2026-11-17T10:00:00.000Z', submission: null, done: 'd', next: 'Writing tests', artifacts: [], blocker: null } };
    renderBoard(planOf('verified', [item(1, { status: 'in_progress', progress })]), { activity: [makeActivity(ref('s-01'), 'working')] });
    const el = card(1);
    expect(el.textContent).toContain('S01 back');
    expect(el.textContent).toContain('working');
    expect(el.textContent).toContain('Writing tests');
    expect(el.querySelector('[data-agent-colour="1"]')).toBeTruthy();
    expect(el.querySelector('[data-board-stripe]')?.getAttribute('style')).toContain('--agent-colour-1');
  });

  it('заблокированный пункт и ожидание человека выделены; при ожидании человека слово состояния не дублируется', () => {
    const blocked = planOf('verified', [item(1, { status: 'blocked', note: 'No access' })]);
    renderBoard(blocked, { activity: [makeActivity(ref('s-01'), 'working')] });
    expect(card(1).querySelector('[data-board-obstacle]')?.textContent).toBe(S.roomBoard.blocked('No access'));
    expect(card(1).textContent).toContain('working');
    cleanup();
    const need = makeActivity(ref('s-01'), 'blocked', { need: makeNeed('approval') });
    renderBoard(planOf('verified', [item(1, { status: 'in_progress' })]), { activity: [need] });
    const obstacle = card(1).querySelector('[data-board-obstacle]')?.textContent ?? '';
    expect(obstacle).toBeTruthy();
    expect(card(1).textContent?.split(obstacle).join('')).not.toMatch(/blocked|waiting/i);
  });

  it('In review: ждёт проверяющего, ждёт человека, проверить некому', () => {
    renderBoard(planOf('verified', [item(1, { status: 'done' }), item(2, { status: 'done', verifier: 'human' }), item(3, { status: 'done', verifier: null, owner: 's-03' })]));
    expect(card(1).textContent).toContain(S.roomBoard.waitingFor('S02 front'));
    expect(card(2).textContent).toContain(S.roomBoard.waitingForYou);
    expect(card(3).textContent).toContain(S.roomBoard.noVerifier);
  });

  it('Autonomous: состояние попытки, текст проверки, attempt n of m', () => {
    const base = autonomousPlan();
    const plan = autoPlan([item(1, { status: 'in_progress' })], [attempt({ item: 1, status: 'checking' })]);
    plan.autonomous!.ops = [{ ...base.ops[0]!, result: { checkResult: { ...(base.ops[0]!.result!.checkResult as object), verdict: 'fail' } } as never }];
    renderBoard(plan);
    const text = card(1).textContent ?? '';
    expect(text).toContain(`${S.plans.attemptStatus.checking} · verifier:0 → fail`);
    expect(text).toMatch(/attempt \d+ of \d+/);
  });

  it('основание из Checklist подписано; номер сдачи и время обновления показаны', () => {
    const log = [1, 2].map((n) => ({ at: `2026-11-17T0${n}:00:00.000Z`, by: 's-01', status: 'done' as const, note: null }));
    renderBoard(planOf('verified', [item(1, { status: 'done', acceptedChecklistRevision: 1 }), item(2, { status: 'done', log })]));
    expect(card(1).textContent).toContain(S.plans.basis(1));
    expect(card(2).textContent).toContain(S.roomBoard.submission(2));
    expect(card(2).textContent).toContain('updated');
  });

  it('исполнителя нет в карте: подпись без значка, полоса нейтральная', () => {
    renderBoard(planOf('verified', [item(1, { owner: 's-09', status: 'in_progress' })]));
    expect(card(1).textContent).toContain('s-09');
    expect(card(1).querySelector('[data-agent-icon]')).toBeNull();
    expect(card(1).querySelector('[data-board-stripe]')?.getAttribute('style')).toContain('--color-neutral-400');
  });

  it('автономный пункт без исполнителя — Engine, полоса нейтральная', () => {
    renderBoard(autoPlan([item(1, { status: 'in_progress' })], []));
    expect(card(1).textContent).toContain(S.roomBoard.engine);
    expect(card(1).querySelector('[data-board-stripe]')?.getAttribute('style')).toContain('--color-neutral-400');
  });

  it('Waiting: «Ready» или «Waits for #…»', () => {
    renderBoard(planOf('verified', [item(1, { status: 'in_progress' }), item(2, { after: [1] }), item(3, { status: 'ready' })]));
    expect(card(2).textContent).toContain(S.roomBoard.waitsFor('#1'));
    expect(card(3).textContent).toContain(S.roomBoard.ready);
  });

  it('возврат: замечание показано', () => {
    renderBoard(planOf('verified', [item(1, { status: 'returned', note: 'Fix the test' })]));
    expect(card(1).textContent).toContain(S.roomBoard.returned('Fix the test'));
  });

  it('запасной случай: рядом с названием стоит слово состояния пункта', () => {
    // Автономный пункт `done` без попытки на проверке стоит в In progress: колонка не знает, как назвать его состояние.
    renderBoard(autoPlan([item(1, { status: 'done' }), item(2, { status: 'in_progress' }), item(3, { status: 'blocked' })], []));
    expect(column('progress').contains(card(1))).toBe(true);
    expect(card(1).querySelector('[data-board-status]')?.textContent).toBe(S.plans.itemStatus.done);
    expect(card(2).querySelector('[data-board-status]')).toBeNull();
    expect(card(3).querySelector('[data-board-status]')).toBeNull();
  });

  it('нажатие на карточку зовёт onOpenItem с номером пункта один раз', () => {
    const onOpenItem = vi.fn();
    renderBoard(planOf('verified', [item(1), item(2, { status: 'in_progress' })]), {}, { onOpenItem });
    fireEvent.click(card(2));
    expect(onOpenItem).toHaveBeenCalledTimes(1);
    expect(onOpenItem).toHaveBeenCalledWith(2);
  });

  // jsdom не переводит Enter в click у кнопки (это делает браузер), а user-event в окне не подключён: сам Enter проверяет
  // сквозной сценарий задачи 9. Здесь — то, что даёт браузеру эту активацию: карточка — родная включённая кнопка с фокусом,
  // Enter на ней не перехватывается.
  it('карточка — родная кнопка, берёт фокус, Enter на ней не отменяется', () => {
    const onOpenItem = vi.fn();
    renderBoard(planOf('verified', [item(1)]), {}, { onOpenItem });
    const el = card(1) as HTMLButtonElement;
    expect(el.tagName).toBe('BUTTON');
    expect(el.disabled).toBe(false);
    expect(el.tabIndex).toBeGreaterThanOrEqual(0);
    el.focus();
    expect(document.activeElement).toBe(el);
    const notCancelled = fireEvent.keyDown(el, { key: 'Enter', code: 'Enter' });
    expect(notCancelled).toBe(true);
  });

  it('без onOpenItem нажатие ничего не делает', () => {
    renderBoard(planOf('verified', [item(1)]));
    expect(() => fireEvent.click(card(1))).not.toThrow();
  });
});

describe('RoomBoard — уведомление и фильтр', () => {
  it('уведомление о решении; Open feed зовёт onOpenFeed', () => {
    const proposal = { proposal: { id: 'p', by: 's-03', at: 'x', text: 't' } } as unknown as Partial<Room>;
    const { props } = renderBoard(planOf('verified', [item(1)]), { room: proposal });
    const notice = document.querySelector('[data-board-notice]') as HTMLElement;
    expect(notice.textContent).toContain(S.roomBoard.noticeDecision);
    fireEvent.click(within(notice).getByRole('button', { name: S.roomBoard.openFeed }));
    expect(props.onOpenFeed).toHaveBeenCalledTimes(1);
  });

  it('уведомление об остановке плана', () => {
    renderBoard(autoPlan([item(1)], [], { reason: 'budget', at: 'x', detail: 'budget spent' }));
    expect(document.querySelector('[data-board-notice]')?.textContent).toContain(S.plans.haltNotice('budget spent'));
  });

  it('без решения и остановки уведомления нет', () => {
    renderBoard(planOf('verified', [item(1)]));
    expect(document.querySelector('[data-board-notice]')).toBeNull();
  });

  it('фильтр по исполнителю и по проверяющему бледнит чужие карточки, повторное нажатие снимает', () => {
    const plan = planOf('verified', [
      item(1, { status: 'in_progress', owner: 's-01' }),
      item(2, { status: 'in_progress', owner: 's-03' }),
      item(3, { status: 'done', owner: 's-03', verifier: 's-02' }),
    ]);
    renderBoard(plan);
    const group = screen.getByRole('group', { name: S.roomBoard.filter });
    const buttons = within(group).getAllByRole('button');
    expect(buttons).toHaveLength(3);
    const dimmed = (id: number): boolean => card(id).className.includes('opacity-30');
    fireEvent.click(within(group).getByTitle(S.roomBoard.filterOnly('S01 back')));
    expect([1, 2, 3].map(dimmed)).toEqual([false, true, true]);
    expect(within(group).getByTitle(S.roomBoard.filterOnly('S01 back')).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(group).getByTitle(S.roomBoard.filterOnly('S02 front')));
    expect([1, 2, 3].map(dimmed)).toEqual([true, true, false]);
    fireEvent.click(within(group).getByTitle(S.roomBoard.filterOnly('S02 front')));
    expect([1, 2, 3].map(dimmed)).toEqual([false, false, false]);
  });
});
