import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { S } from '../../shared/strings.js';
import { AgentBadge } from './AgentBadge.js';

afterEach(cleanup);

describe('AgentBadge', () => {
  it('ярлык сессии, Stop зовёт onStop, подсказка — последние операции', () => {
    const onStop = vi.fn();
    render(<AgentBadge session="S02" recent={['snapshot', 'action click', 'wait_for']} onStop={onStop} />);
    expect(screen.getByText('S02')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: S.browser.panel.agentStop }));
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('agent-badge').getAttribute('title')).toContain('action click');
  });
});
