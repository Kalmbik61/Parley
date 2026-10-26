import { afterEach, beforeEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HaltCard } from './HaltCard.js';
import { autonomousRoomPlan } from '../../test-utils/autonomous-plan.js';
import { makeWork } from '../../test-utils/work-fixtures.js';
import { createFakeBridge } from '../../test-utils/fake-bridge.js';
import { useHostStore } from '../../store/host.js';
beforeEach(() => useHostStore.setState({ connections: 1, status: { state: 'connected', hostVersion: 'test', methods: ['plans.resumeAutonomous'] } }));
afterEach(cleanup);
it('uses a neutral heading for human reason, sends the current revision and waits for the map', async () => {
  const plan = autonomousRoomPlan(), entry = makeWork('w-01'), bridge = createFakeBridge();
  bridge.setHandler('plans.resumeAutonomous', () => ({ ok: true }));
  const view = render(<HaltCard plan={plan} entry={entry} bridge={bridge} />);
  expect(screen.getByText('Execution stopped')).toBeTruthy();
  expect(screen.getByText('capture: unexpected failure')).toBeTruthy();
  expect(screen.queryByText(/stopped by.*human/i)).toBeNull();
  fireEvent.click(screen.getByText('Continue')); fireEvent.click(screen.getByText('Continue'));
  await waitFor(() => expect(bridge.calls).toHaveLength(1));
  expect(bridge.calls[0]).toMatchObject({ method: 'plans.resumeAutonomous', params: { projectPath: entry.projectPath, workId: 'w-01', roomId: 'r-01', planId: 'pl-01', rev: 2 } });
  expect(screen.getByText('Execution stopped')).toBeTruthy();
  view.rerender(<HaltCard plan={{ ...plan, autonomous: { ...plan.autonomous!, halted: null } }} entry={entry} bridge={bridge} />);
  expect(screen.queryByText('Execution stopped')).toBeNull();
});
it('hides Continue on an old host', () => {
  useHostStore.setState({ status: { state: 'connected', hostVersion: 'old', methods: [] } });
  render(<HaltCard plan={autonomousRoomPlan()} entry={makeWork('w-01')} bridge={createFakeBridge()} />);
  expect(screen.queryByText('Continue')).toBeNull();
});
it('shows conflicts and keeps the halt detail', async () => {
  const bridge = createFakeBridge(); bridge.setHandler('plans.resumeAutonomous', () => { throw { code: 'conflict', message: 'stale' }; });
  render(<HaltCard plan={autonomousRoomPlan()} entry={makeWork('w-01')} bridge={bridge} />);
  fireEvent.click(screen.getByText('Continue'));
  expect(await screen.findByRole('status')).toHaveProperty('textContent', 'The plan changed. Review the current revision and try again.');
  expect(screen.getByText('capture: unexpected failure')).toBeTruthy();
});

it('keeps Continue disabled after acknowledgement until the map changes', async () => {
  const bridge = createFakeBridge(); bridge.setHandler('plans.resumeAutonomous', () => ({ ok: true }));
  render(<HaltCard plan={autonomousRoomPlan()} entry={makeWork('w-01')} bridge={bridge} />);
  fireEvent.click(screen.getByText('Continue'));
  await screen.findByText('The host accepted the action.');
  expect(screen.getByText('Continue')).toHaveProperty('disabled', true);
});
it('disables Continue for a closed workspace', () => {
  const entry = makeWork('w-01'); entry.map.work.status = 'closed';
  render(<HaltCard plan={autonomousRoomPlan()} entry={entry} bridge={createFakeBridge()} />);
  expect(screen.getByText('Continue')).toHaveProperty('disabled', true);
});
