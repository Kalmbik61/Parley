import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { S } from '../../shared/strings.js';
import { useWorksStore } from '../store/works.js';
import { WorksErrorBanner } from './WorksErrorBanner.js';

beforeEach(() => useWorksStore.setState({ error: null, syncStatus: null, mailRepairPending: 0, mailRepairFailed: false, retrySync: () => {} }));
afterEach(cleanup);
it('shows bootstrap progress without claiming readiness', () => {
  useWorksStore.setState({ syncStatus: { state: 'loading', epoch: null, applied: 0, wanted: 1, pages: 2, rows: 12 }, ready: false });
  render(<WorksErrorBanner />);
  expect(screen.getByRole('status').textContent).toContain('12');
  expect(useWorksStore.getState().ready).toBe(false);
});
it('shows a persistent stale alert and an explicit retry', () => {
  const retrySync = vi.fn();
  useWorksStore.setState({ retrySync, syncStatus: { state: 'stale', epoch: 'a', applied: 1, wanted: 2, reason: 'no-commit' } });
  render(<WorksErrorBanner />);
  expect(screen.getByRole('alert').textContent).toContain(S.works.syncStale);
  fireEvent.click(screen.getByRole('button', { name: S.common.retry }));
  expect(retrySync).toHaveBeenCalledTimes(1);
});
it('keeps pending mail reconciliation visible even when structural sync is current', () => {
  useWorksStore.setState({ syncStatus: { state: 'current', epoch: 'a', applied: 1 }, mailRepairPending: 1 });
  render(<WorksErrorBanner />);
  expect(screen.getByRole('status').textContent).toBe(S.works.mailRepair);
});
it('keeps the legacy load error banner', () => {
  useWorksStore.setState({ error: { code: 'failed', reason: 'works-unreadable' } });
  render(<WorksErrorBanner />);
  expect(screen.getByRole('alert').textContent).toBe(S.works.unreadable);
});

it('shows failed authoritative mail repair as an alert with retry', () => {
  const retrySync = vi.fn();
  useWorksStore.setState({ retrySync, syncStatus: { state: 'current', epoch: 'a', applied: 1 }, mailRepairPending: 1, mailRepairFailed: true });
  render(<WorksErrorBanner />);
  expect(screen.getByRole('alert').textContent).toContain(S.works.mailRepairFailed);
  fireEvent.click(screen.getByRole('button', { name: S.common.retry }));
  expect(retrySync).toHaveBeenCalledTimes(1);
});
