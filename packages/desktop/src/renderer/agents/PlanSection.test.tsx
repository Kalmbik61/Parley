import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { capPlan, type AgentPlanItem } from '@parley/core/agent-plan';
import { PlanSection } from './PlanSection.js';
afterEach(cleanup);
const item = (
  subject: string,
  status: AgentPlanItem['status'],
  description: string | null = null,
): AgentPlanItem => ({ id: subject, subject, status, description, activeForm: null });
const plan = (items: AgentPlanItem[], partial = false) =>
  capPlan({ items, partial, explanation: 'Approach', updatedAt: '2026-10-18' });
it('expands the current item, toggles descriptions, and leaves plain items unexpandable', () => {
  render(
    <PlanSection
      plan={plan([
        item('Current', 'in_progress', 'Current details'),
        item('Later', 'pending', 'Later details'),
        item('Plain', 'pending'),
      ])}
      links={[]}
      onOpenRoom={vi.fn()}
    />,
  );
  expect(screen.getByText('Current details')).toBeTruthy();
  expect(screen.queryByText('Later details')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Later' }));
  expect(screen.getByText('Later details')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Plain' })).toBeNull();
});
it('opens the linked room and exposes its scope', () => {
  const open = vi.fn();
  render(
    <PlanSection
      plan={plan([])}
      links={[{ roomId: 'r-01', planId: 'pl-01', itemId: 2, title: 'Implement', scope: 'Backend' }]}
      onOpenRoom={open}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'pl-01 · item 2: Implement' }));
  expect(open).toHaveBeenCalledWith('r-01');
  expect(screen.getByTitle('Backend')).toBeTruthy();
});
it('uses the saved full summary and shows omitted items', () => {
  render(
    <PlanSection
      plan={plan(Array.from({ length: 60 }, (_, i) => item(String(i), 'completed')))}
      links={[]}
      onOpenRoom={vi.fn()}
    />,
  );
  expect(screen.getByText('Plan · 60/60')).toBeTruthy();
  expect(screen.getByText('+10 more')).toBeTruthy();
});
it('keeps the original current item beyond the display limit', () => {
  render(
    <PlanSection
      plan={plan(
        Array.from({ length: 60 }, (_, i) =>
          item(`Step ${i + 1}`, i === 50 ? 'in_progress' : 'pending'),
        ),
      )}
      links={[]}
      onOpenRoom={vi.fn()}
    />,
  );
  expect(screen.getByText('Step 51')).toBeTruthy();
});
it('warns for partial history without an exact total', () => {
  render(
    <PlanSection plan={plan([item('Done', 'completed')], true)} links={[]} onOpenRoom={vi.fn()} />,
  );
  expect(screen.getByText('Plan')).toBeTruthy();
  expect(screen.getByText('Plan may be incomplete')).toBeTruthy();
  expect(screen.queryByText(/1\/1/)).toBeNull();
});

it('expands when an existing item starts and preserves manual toggles on ordinary updates', () => {
  const view = (status: AgentPlanItem['status'], description = 'Details') => (
    <PlanSection plan={plan([item('Work', status, description)])} links={[]} onOpenRoom={vi.fn()} />
  );
  const { rerender } = render(view('pending'));
  expect(screen.queryByText('Details')).toBeNull();
  rerender(view('in_progress'));
  expect(screen.getByText('Details')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Work' }));
  rerender(view('in_progress', 'Updated details'));
  expect(screen.queryByText('Updated details')).toBeNull();
  rerender(view('completed'));
  expect(screen.queryByText('Details')).toBeNull();
  rerender(view('in_progress'));
  expect(screen.getByText('Details')).toBeTruthy();
});


it('shows room assignments and an honest empty state before personal steps exist', () => {
  const open = vi.fn();
  render(<PlanSection plan={null} links={[{ roomId: 'r-01', planId: 'pl-01', itemId: 1, title: 'Build', scope: 'Scope' }]} onOpenRoom={open} />);
  expect(screen.getByText(/No personal steps published yet/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'pl-01 · item 1: Build' }));
  expect(open).toHaveBeenCalledWith('r-01');
});
