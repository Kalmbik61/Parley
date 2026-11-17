/** Панель пункта (спека доски комнаты 4.4): только чтение; исполнитель, тело строки списка плана, два перехода. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { PlanAttempt, PlanItem, PlanMode, Room, RoomPlan, WindowWorkEntry } from '@parley/core';
import { S } from '../../../../shared/strings.js';
import { createFakeBridge } from '../../../test-utils/fake-bridge.js';
import { autonomousPlan } from '../../../test-utils/autonomous-plan.js';
import { makeRoom, makeSession, makeWork } from '../../../test-utils/work-fixtures.js';
import { RoomBoardItemSheet, type RoomBoardItemSheetProps } from './RoomBoardItemSheet.js';
import type { BoardAgent } from './room-board-model.js';

afterEach(cleanup);

const item = (id: number, patch: Partial<PlanItem> = {}): PlanItem => ({
  id, title: `Item ${id}`, owner: 's-01', scope: 'src/payments', after: [], criteria: ['Refund works'], verifier: 's-02', status: 'in_progress', evidence: null, note: null, log: [], ...patch,
});
const planOf = (mode: PlanMode, items: PlanItem[], patch: Partial<RoomPlan> = {}): RoomPlan => ({
  id: 'pl-01', roomId: 'r-01', rev: 2, mode, status: 'active', goal: 'Goal', items, backlog: [],
  acceptedAt: 'x', completedAt: null, cancelledAt: null, completionSummary: null, ...patch,
});
const claudeAgent: BoardAgent = { id: 's-01', label: 'S01 back', provider: 'claude', word: 'working' };

function renderSheet(plan: RoomPlan, patch: Partial<RoomBoardItemSheetProps> = {}) {
  const room: Room = { ...makeRoom('r-01', 'Delivery'), members: ['s-01', 's-02'], lead: 's-01' };
  const entry: WindowWorkEntry = makeWork('w-01', { sessions: [makeSession('s-01', 'back'), makeSession('s-02', 'front')], rooms: [room] });
  entry.map.plans = [plan];
  const props: RoomBoardItemSheetProps = {
    plan, item: plan.items[0]!, agent: claudeAgent, entry, bridge: createFakeBridge(),
    onClose: vi.fn(), onReturnFocus: vi.fn(), onOpenSession: vi.fn(), onShowInFeed: vi.fn(), ...patch,
  };
  return { ...render(<RoomBoardItemSheet {...props} />), props };
}

const sheet = (): HTMLElement => document.querySelector('[data-room-item-sheet]') as HTMLElement;

describe('RoomBoardItemSheet', () => {
  it('показывает исполнителя со значком, состояние, обязанности, отметку хода и раскрытые критерии', () => {
    const progress = { owner: { by: 's-01', at: '2026-11-17T10:00:00.000Z', submission: null, done: 'Wrote the refund path', next: 'Add tests', artifacts: [], blocker: null } };
    renderSheet(planOf('verified', [item(1, { progress })]));
    expect(screen.getByText(S.roomBoard.sheet(1))).toBeTruthy();
    const who = sheet().querySelector('[data-sheet-agent]') as HTMLElement;
    expect(who.textContent).toContain('S01 back');
    expect(who.textContent).toContain('working');
    expect(who.querySelector('[data-agent-colour="1"]')).toBeTruthy();
    expect(sheet().querySelector('[data-plan-item-title]')?.textContent).toBe('1. Item 1');
    expect(sheet().textContent).toContain(S.plans.itemStatus.in_progress);
    expect(sheet().querySelector('[data-plan-duties]')).toBeTruthy();
    expect(sheet().textContent).toContain('Wrote the refund path');
    expect(sheet().querySelector('details')?.hasAttribute('open')).toBe(true);
    expect(sheet().textContent).toContain('Refund works');
  });

  it('у автономного пункта видна последняя попытка и её проверка', () => {
    const base = autonomousPlan();
    const attempt: PlanAttempt = { ...base.attempts[0]!, item: 1, status: 'checking' };
    const plan = planOf('autonomous', [item(1)], { autonomous: { ...base, attempts: [attempt] } as never });
    renderSheet(plan, { agent: null });
    expect(sheet().querySelector('[data-plan-attempt]')?.textContent).toContain(S.plans.attemptStatus.checking);
  });

  it('действий над планом в панели нет', () => {
    renderSheet(planOf('verified', [item(1, { status: 'done' })]));
    const labels = [...sheet().querySelectorAll('button')].map((button) => button.textContent);
    expect(labels).toContain(S.roomBoard.openSession);
    expect(labels).toContain(S.roomBoard.showInFeed);
    for (const text of [S.plans.markDone, S.plans.submit, S.plans.verify, S.plans.returnItem]) expect(labels).not.toContain(text);
    expect(sheet().querySelector('form, textarea, input')).toBeNull();
  });

  it('Open session есть у сессии из карты, зовёт onOpenSession; нет у сессии вне карты и у Engine', () => {
    const plan = planOf('verified', [item(1)]);
    const first = renderSheet(plan);
    fireEvent.click(screen.getByRole('button', { name: S.roomBoard.openSession }));
    expect(first.props.onOpenSession).toHaveBeenCalledWith('s-01');
    cleanup();
    renderSheet(plan, { agent: { id: 's-09', label: 's-09', provider: null, word: '' } });
    expect(screen.queryByRole('button', { name: S.roomBoard.openSession })).toBeNull();
    expect(sheet().querySelector('[data-agent-icon]')).toBeNull();
    cleanup();
    renderSheet(plan, { agent: null });
    expect(screen.queryByRole('button', { name: S.roomBoard.openSession })).toBeNull();
    expect(sheet().textContent).toContain(S.roomBoard.engine);
  });

  it('Show in feed зовёт onShowInFeed', () => {
    const { props } = renderSheet(planOf('verified', [item(1)]));
    fireEvent.click(screen.getByRole('button', { name: S.roomBoard.showInFeed }));
    expect(props.onShowInFeed).toHaveBeenCalledTimes(1);
  });

  it('Esc зовёт onClose', () => {
    const { props } = renderSheet(planOf('verified', [item(1)]));
    fireEvent.keyDown(sheet(), { key: 'Escape', code: 'Escape' });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('без пункта панель закрыта', () => {
    renderSheet(planOf('verified', [item(1)]), { item: null });
    expect(sheet()).toBeNull();
  });
});
