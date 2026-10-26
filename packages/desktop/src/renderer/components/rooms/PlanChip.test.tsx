import { PlanHaltBadge } from './PlanChip.js';
import { autonomousRoomPlan } from '../../test-utils/autonomous-plan.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { capPlan } from '@parley/core/agent-plan';
import { PlanChip, PlanHover } from './PlanChip.js';

afterEach(cleanup);
const plan = (partial = false) =>
  capPlan({
    items: [
      { id: '1', subject: 'Done step', description: null, activeForm: null, status: 'completed' },
      {
        id: '2',
        subject: 'Current step',
        description: 'one\ntwo\nthree\nfour\nfive\nsix\nseven',
        activeForm: null,
        status: 'in_progress',
      },
      { id: '3', subject: 'Next step', description: null, activeForm: null, status: 'pending' },
    ],
    explanation: 'The approach',
    partial,
    updatedAt: '2026-10-18T00:00:00Z',
  });
const hover = async (trigger: HTMLElement) => {
  fireEvent.pointerEnter(trigger, { pointerType: 'mouse' });
  await screen.findByText('The approach');
};

describe('PlanChip and shared PlanHover', () => {
  it('hover shows steps and exactly the first six description lines', async () => {
    render(<PlanChip plan={plan()} onOpen={vi.fn()} />);
    await hover(screen.getByRole('button', { name: '1/3' }));
    expect(screen.getByText('Done step')).toBeTruthy();
    expect(screen.getByText('Current step')).toBeTruthy();
    expect(screen.getByText('Next step')).toBeTruthy();
    expect(screen.getByTestId('plan-current-description').textContent).toBe(
      'one\ntwo\nthree\nfour\nfive\nsix',
    );
    expect(screen.queryByText(/seven/)).toBeNull();
  });
  it('both chip click and Open in Agents open the plan', async () => {
    const onOpen = vi.fn();
    render(<PlanChip plan={plan()} onOpen={onOpen} />);
    const chip = screen.getByRole('button', { name: '1/3' });
    fireEvent.click(chip);
    await hover(chip);
    fireEvent.click(screen.getByRole('button', { name: 'Open in Agents' }));
    expect(onOpen).toHaveBeenCalledTimes(2);
  });
  it('the plan line trigger opens the same hover details', async () => {
    render(
      <PlanHover plan={plan()} onOpen={vi.fn()}>
        <button>▸ Current step</button>
      </PlanHover>,
    );
    await hover(screen.getByRole('button', { name: '▸ Current step' }));
    expect(screen.getByText('Done step')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open in Agents' })).toBeTruthy();
  });
  it('shows omitted steps in a scrollable list', async () => {
    render(<PlanChip plan={{ ...plan(), omitted: 10 }} onOpen={vi.fn()} />);
    await hover(screen.getByRole('button', { name: '1/3' }));
    expect(screen.getByText('+10 more')).toBeTruthy();
    expect(screen.getByTestId('plan-hover-body').className).toContain('overflow-y-auto');
  });
  it('bounds long explanations and steps together while keeping the open action outside scrolling', async () => {
    const explanation = 'UnbrokenExplanation'.repeat(500);
    const onOpen = vi.fn();
    render(<PlanChip plan={{ ...plan(), explanation }} onOpen={onOpen} />);
    fireEvent.pointerEnter(screen.getByRole('button', { name: '1/3' }), { pointerType: 'mouse' });
    const text = await screen.findByText(explanation);
    const body = screen.getByTestId('plan-hover-body');
    const popup = screen.getByTestId('plan-hover');
    const action = screen.getByRole('button', { name: 'Open in Agents' });
    expect(body.contains(text)).toBe(true);
    expect(body.contains(screen.getByTestId('plan-hover-list'))).toBe(true);
    expect(body.className).toContain('min-h-0');
    expect(body.className).toContain('overflow-y-auto');
    expect(body.className).toContain('break-words');
    expect(popup.className).toContain('--radix-hover-card-content-available-height');
    expect(popup.className).toContain('calc(100vh-32px)');
    expect(body.contains(action)).toBe(false);
    expect(action.parentElement).toBe(popup);
    expect(action.className).toContain('shrink-0');
    fireEvent.click(action);
    expect(onOpen).toHaveBeenCalledOnce();
  });
  it('partial plans show a warning and no exact total anywhere', async () => {
    render(<PlanChip plan={plan(true)} onOpen={vi.fn()} />);
    await hover(screen.getByRole('button', { name: 'Plan' }));
    expect(screen.getByText('Plan may be incomplete')).toBeTruthy();
    expect(screen.queryByText('1/3')).toBeNull();
  });
});

it('shows a halt badge with the engine detail and removes it when resumed', () => {
  const roomPlan = autonomousRoomPlan();
  const view = render(<PlanHaltBadge plan={roomPlan} />);
  expect(screen.getByText('Execution stopped').title).toBe('capture: unexpected failure');
  view.rerender(<PlanHaltBadge plan={{ ...roomPlan, autonomous: { ...roomPlan.autonomous!, halted: null } }} />);
  expect(screen.queryByText('Execution stopped')).toBeNull();
});
