import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlanView, type PlanViewProps } from './PlanView.js';

const LABELS = {
  plan: 'Plan',
  approveAuto: 'Approve, auto-accept edits',
  approveManual: 'Approve, approve each edit',
  changeInTerminal: 'Change plan in terminal',
  truncated: 'Truncated',
  terminalOnly: 'Approval is available in the terminal',
  openInParley: 'Open in Parley',
};

function props(patch: Partial<PlanViewProps> = {}): PlanViewProps {
  return {
    card: {
      id: 'p-1', cardId: 'p-1', at: '', kind: 'plan', state: 'pending',
      toolUseId: null, toolName: 'ExitPlanMode', toolInput: {},
      plan: 'First step\nLast step', planFilePath: '/unread/plan.md',
    },
    disabled: false, canDecide: true, maxBodyHeight: 280, labels: LABELS,
    onDecide: vi.fn(), onOpenTerminal: vi.fn(), onOpenInParley: vi.fn(),
    ...patch,
  };
}

afterEach(cleanup);

describe('PlanView', () => {
  it('preserves the full 16 KiB plan and renders HTML, images and URLs as inert text', () => {
    const content = '<img src="https://example.com/image" onerror="alert(1)">\nhttps://example.com\n';
    const plan = content + 'x'.repeat(16 * 1024 - content.length - 5) + '\nEND!';
    const p = props();
    const { container } = render(<PlanView {...p} card={{ ...p.card, plan }} />);
    const body = screen.getByRole('region', { name: LABELS.plan });
    expect(body.textContent).toBe(plan);
    expect(body.className).toContain('whitespace-pre-wrap');
    expect(body.className).toContain('overflow-y-auto');
    expect(body.className).toContain('[overflow-wrap:anywhere]');
    expect(body.className).not.toMatch(/line-clamp|truncate/);
    expect(container.querySelector('img, a, script, iframe')).toBeNull();
    expect(container.textContent).not.toContain(p.card.planFilePath);
    expect(document.activeElement).toBe(document.body);
  });

  it.each([[400, 280], [112, 112], [0, 0], [-12, 0]])('limits body height %s to %s without placing actions inside the scroll area', (available, expected) => {
    render(<PlanView {...props({ maxBodyHeight: available })} />);
    const body = screen.getByRole('region', { name: LABELS.plan });
    expect(body.style.maxHeight).toBe(`${expected}px`);
    expect(body.querySelector('button')).toBeNull();
    expect(screen.getByRole('button', { name: LABELS.changeInTerminal })).toBeTruthy();
    expect(screen.getByRole('button', { name: LABELS.openInParley })).toBeTruthy();
  });

  it.each([
    [LABELS.approveAuto, 'auto-accept'],
    [LABELS.approveManual, 'manual'],
  ] as const)('sends only the explicit %s choice', (label, choice) => {
    const p = props();
    render(<PlanView {...p} />);
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(p.onDecide).toHaveBeenCalledOnce();
    expect(p.onDecide).toHaveBeenCalledWith(choice);
    expect(p.onOpenTerminal).not.toHaveBeenCalled();
    expect(p.onOpenInParley).not.toHaveBeenCalled();
  });

  it('obeys parent arming/deciding while keeping both navigation actions available', () => {
    const p = props({ disabled: true });
    const view = render(<PlanView {...p} />);
    for (const name of [LABELS.approveAuto, LABELS.approveManual]) {
      const button = screen.getByRole('button', { name }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      fireEvent.click(button);
    }
    expect(p.onDecide).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: LABELS.changeInTerminal }));
    fireEvent.click(screen.getByRole('button', { name: LABELS.openInParley }));
    expect(p.onOpenTerminal).toHaveBeenCalledOnce();
    expect(p.onOpenInParley).toHaveBeenCalledOnce();
    expect(p.onDecide).not.toHaveBeenCalled();
    view.rerender(<PlanView {...p} disabled={false} />);
    expect((screen.getByRole('button', { name: LABELS.approveAuto }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('does not send a second choice once the parent starts deciding', () => {
    const p = props();
    function Parent(): JSX.Element {
      const [deciding, setDeciding] = useState(false);
      return <PlanView {...p} disabled={deciding} onDecide={(choice) => {
        p.onDecide(choice);
        setDeciding(true);
      }} />;
    }
    render(<Parent />);
    fireEvent.click(screen.getByRole('button', { name: LABELS.approveAuto }));
    fireEvent.click(screen.getByRole('button', { name: LABELS.approveManual }));
    expect(p.onDecide).toHaveBeenCalledOnce();
    expect(p.onDecide).toHaveBeenCalledWith('auto-accept');
  });

  it('shows a terminal-only plan with readable text and navigation but no approval actions', () => {
    const p = props({ canDecide: false });
    render(<PlanView {...p} />);
    expect(screen.getByRole('region', { name: LABELS.plan }).textContent).toBe(p.card.plan);
    expect(screen.getByText(LABELS.terminalOnly)).toBeTruthy();
    expect(screen.queryByRole('button', { name: LABELS.approveAuto })).toBeNull();
    expect(screen.queryByRole('button', { name: LABELS.approveManual })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: LABELS.changeInTerminal }));
    expect(p.onOpenTerminal).toHaveBeenCalledOnce();
    expect(p.onDecide).not.toHaveBeenCalled();
  });

  it('marks host truncation and offers the main interface without recovering the plan file', () => {
    const p = props();
    render(<PlanView {...p} card={{ ...p.card, truncated: true }} />);
    expect(screen.getByText(LABELS.truncated)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: LABELS.openInParley }));
    expect(p.onOpenInParley).toHaveBeenCalledOnce();
    expect(p.onDecide).not.toHaveBeenCalled();
  });

  it('renders updated text for the same card ID and follows the parent rearm', () => {
    const p = props();
    const view = render(<PlanView {...p} />);
    view.rerender(<PlanView {...p} card={{ ...p.card, plan: 'Changed plan' }} disabled />);
    expect(screen.getByRole('region', { name: LABELS.plan }).textContent).toBe('Changed plan');
    fireEvent.click(screen.getByRole('button', { name: LABELS.approveAuto }));
    expect(p.onDecide).not.toHaveBeenCalled();
  });

  it('does not approve a card that has already settled elsewhere', () => {
    const p = props();
    render(<PlanView {...p} card={{ ...p.card, state: 'elsewhere' }} />);
    expect(screen.getByRole('region', { name: LABELS.plan }).textContent).toBe(p.card.plan);
    for (const name of [LABELS.approveAuto, LABELS.approveManual]) {
      const button = screen.queryByRole('button', { name });
      if (button !== null) fireEvent.click(button);
    }
    expect(p.onDecide).not.toHaveBeenCalled();
  });
});
