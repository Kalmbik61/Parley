import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomHistoryStatusView } from '@parley/protocol';
import { encodeIpcError } from '../../../shared/ipc-error.js';
import { useHostStore } from '../../store/host.js';
import { createFakeBridge, type FakeBridge } from '../../test-utils/fake-bridge.js';
import { RoomHistoryMenu } from './RoomHistoryMenu.js';

const METHODS = ['rooms.history.get', 'rooms.history.share', 'rooms.history.unshare'];
const NOT_SHARED: RoomHistoryStatusView = { state: 'not-shared', sharedAt: null, version: 'missing', diagnostics: [] };
const SHARED: RoomHistoryStatusView = { state: 'shared', sharedAt: '2026-10-05T10:00:00.000Z', version: 'v1', diagnostics: [] };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
let bridge: FakeBridge;
const show = (roomId = 'r-01') => <RoomHistoryMenu projectPath="/p" workId="w-01" roomId={roomId} bridge={bridge} />;
const methodsCalled = (name: string) => bridge.calls.filter(call => call.method === name);
const openMenu = async () => { fireEvent.click(screen.getByRole('button', { name: 'History' })); };
beforeEach(() => {
  bridge = createFakeBridge();
  useHostStore.setState({ status: { state: 'connected', hostVersion: 'fixture', methods: METHODS }, connections: 1 });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('room History menu', () => {
  it('does not touch the host while closed; opening reads the state without changing it', async () => {
    bridge.setHandler('rooms.history.get', () => NOT_SHARED);
    render(show());
    expect(bridge.calls).toHaveLength(0);
    await openMenu();
    await screen.findByText('Not shared');
    expect(bridge.calls.map(call => call.method)).toEqual(['rooms.history.get']);
    expect(screen.getByRole('button', { name: 'Share history…' })).toBeTruthy(); expect(screen.queryByRole('button', { name: 'Unshare…' })).toBeNull();
  });
  it('Share needs an explicit confirmation naming Git and secrets; Cancel changes nothing', async () => {
    bridge.setHandler('rooms.history.get', () => NOT_SHARED);
    bridge.setHandler('rooms.history.share', () => SHARED);
    render(show()); await openMenu(); await screen.findByText('Not shared');
    fireEvent.click(screen.getByRole('button', { name: 'Share history…' }));
    expect(screen.getByText('This publishes a snapshot to the project’s shared Git files. Check for secrets before continuing.')).toBeTruthy();
    expect(methodsCalled('rooms.history.share')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(methodsCalled('rooms.history.share')).toHaveLength(0); expect(screen.getByText('Not shared')).toBeTruthy();
    expect(screen.queryByText(/shared Git files/)).toBeNull();
    // Повторный Share — снова явный: прежнее подтверждение не действует.
    fireEvent.click(screen.getByRole('button', { name: 'Share history…' }));
    expect(methodsCalled('rooms.history.share')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Publish snapshot' }));
    await screen.findByText(/^Shared at /);
    expect(methodsCalled('rooms.history.share')).toEqual([{ method: 'rooms.history.share', params: { projectPath: '/p', workId: 'w-01', roomId: 'r-01', expectedVersion: 'missing', confirmed: true } }]);
    expect(screen.getByRole('button', { name: 'Share again…' })).toBeTruthy();
  });
  it('a failed export is visible and never leaves a false shared-at', async () => {
    bridge.setHandler('rooms.history.get', () => NOT_SHARED);
    bridge.setHandler('rooms.history.share', () => { throw new Error('/private/path EACCES'); });
    render(show()); await openMenu(); await screen.findByText('Not shared');
    fireEvent.click(screen.getByRole('button', { name: 'Share history…' })); fireEvent.click(screen.getByRole('button', { name: 'Publish snapshot' }));
    await screen.findByText('The history could not be shared. Nothing was recorded as shared.');
    expect(document.body.textContent).not.toContain('EACCES'); expect(screen.queryByText(/^Shared at /)).toBeNull();
    await waitFor(() => expect(methodsCalled('rooms.history.get')).toHaveLength(2));
    await screen.findByText('Not shared');
  });
  it('a stale-version conflict asks to review and re-reads the host state', async () => {
    let calls = 0;
    bridge.setHandler('rooms.history.get', () => (++calls === 1 ? NOT_SHARED : SHARED));
    bridge.setHandler('rooms.history.share', () => { throw encodeIpcError({ code: 'conflict', message: 'x' }); });
    render(show()); await openMenu(); await screen.findByText('Not shared');
    fireEvent.click(screen.getByRole('button', { name: 'Share history…' })); fireEvent.click(screen.getByRole('button', { name: 'Publish snapshot' }));
    await screen.findByText('The shared history changed. Review it and try again.');
    await screen.findByText(/^Shared at /);
  });
  it('Unshare says Git history keeps the snapshot, and Cancel changes nothing', async () => {
    bridge.setHandler('rooms.history.get', () => SHARED);
    bridge.setHandler('rooms.history.unshare', () => NOT_SHARED);
    render(show()); await openMenu(); await screen.findByText(/^Shared at /);
    fireEvent.click(screen.getByRole('button', { name: 'Unshare…' }));
    expect(screen.getByText('Remove the shared snapshot from the working copy. Previous Git commits retain it.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(methodsCalled('rooms.history.unshare')).toHaveLength(0); expect(screen.getByText(/^Shared at /)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Unshare…' })); fireEvent.click(screen.getByRole('button', { name: 'Remove snapshot' }));
    await screen.findByText('Not shared');
    expect(methodsCalled('rooms.history.unshare')[0]!.params).toEqual({ projectPath: '/p', workId: 'w-01', roomId: 'r-01', expectedVersion: 'v1' });
  });
  it('a foreign or edited shared file offers no Share or Unshare', async () => {
    bridge.setHandler('rooms.history.get', () => ({ state: 'conflict', sharedAt: null, version: 'v9', diagnostics: [] }));
    render(show()); await openMenu();
    await screen.findByText(/will not overwrite or remove it/);
    expect(screen.queryByRole('button', { name: /Share/ })).toBeNull(); expect(screen.queryByRole('button', { name: 'Unshare…' })).toBeNull();
  });
  it('shows Git ignore notes returned with a successful Share', async () => {
    bridge.setHandler('rooms.history.get', () => NOT_SHARED);
    bridge.setHandler('rooms.history.share', () => ({ ...SHARED, diagnostics: [{ code: 'parley-dir-ignored' }] }));
    render(show()); await openMenu(); await screen.findByText('Not shared');
    fireEvent.click(screen.getByRole('button', { name: 'Share history…' })); fireEvent.click(screen.getByRole('button', { name: 'Publish snapshot' }));
    await screen.findByText('The project state folder is ignored by Git, so the shared history stays local.');
  });
  it('an old host or a lost connection makes the actions unavailable without calling', async () => {
    useHostStore.setState({ status: { state: 'connected', hostVersion: 'old', methods: [] } });
    const { unmount } = render(show()); await openMenu();
    expect(screen.getByText('Update or restart the host to share room history.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Share/ })).toBeNull(); expect(bridge.calls).toHaveLength(0);
    unmount();
    useHostStore.setState({ status: { state: 'disconnected' } as never });
    render(show()); await openMenu();
    expect(screen.getByText('Reconnect to the host to share room history.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Share/ })).toBeNull(); expect(bridge.calls).toHaveLength(0);
  });
  it('drops a pending confirmation and old replies when the room or connection changes', async () => {
    const old = deferred<RoomHistoryStatusView>();
    let first = true;
    bridge.setHandler('rooms.history.get', params => { if (params.roomId === 'r-01' && first) { first = false; return old.promise; } return NOT_SHARED; });
    bridge.setHandler('rooms.history.share', () => SHARED);
    const { rerender } = render(show()); await openMenu();
    rerender(show('r-02'));
    await act(async () => { old.resolve(SHARED); });
    expect(screen.queryByText(/^Shared at /)).toBeNull();
    await screen.findByText('Not shared');
    fireEvent.click(screen.getByRole('button', { name: 'Share history…' }));
    expect(screen.getByText(/shared Git files/)).toBeTruthy();
    await act(async () => { useHostStore.setState({ connections: 2 }); });
    expect(screen.queryByText(/shared Git files/)).toBeNull(); expect(methodsCalled('rooms.history.share')).toHaveLength(0);
  });
  it('a share reply that arrives after the connection changed is ignored', async () => {
    const pending = deferred<RoomHistoryStatusView>();
    bridge.setHandler('rooms.history.get', () => NOT_SHARED);
    bridge.setHandler('rooms.history.share', () => pending.promise);
    render(show()); await openMenu(); await screen.findByText('Not shared');
    fireEvent.click(screen.getByRole('button', { name: 'Share history…' })); fireEvent.click(screen.getByRole('button', { name: 'Publish snapshot' }));
    await act(async () => { useHostStore.setState({ connections: 2 }); });
    await act(async () => { pending.resolve(SHARED); });
    expect(screen.queryByText(/^Shared at /)).toBeNull();
  });
  it('an invalid host answer is not shown as shared', async () => {
    bridge.setHandler('rooms.history.get', () => NOT_SHARED);
    bridge.setHandler('rooms.history.share', () => ({ state: 'shared', sharedAt: 'later', version: 'v', diagnostics: [] }) as never);
    render(show()); await openMenu(); await screen.findByText('Not shared');
    fireEvent.click(screen.getByRole('button', { name: 'Share history…' })); fireEvent.click(screen.getByRole('button', { name: 'Publish snapshot' }));
    await screen.findByText('The history could not be shared. Nothing was recorded as shared.');
    expect(screen.queryByText(/^Shared at /)).toBeNull();
  });
  it('applies only the reply of the latest read when two reads overlap', async () => {
    const first = deferred<RoomHistoryStatusView>();
    let calls = 0;
    bridge.setHandler('rooms.history.get', () => (++calls === 1 ? first.promise : NOT_SHARED));
    render(show()); await openMenu();
    await waitFor(() => expect(methodsCalled('rooms.history.get')).toHaveLength(1));
    // Закрыли и открыли заново, пока первое чтение висит: идёт второе, оно и последнее.
    await openMenu(); await openMenu();
    await screen.findByText('Not shared');
    await act(async () => { first.resolve(SHARED); });
    expect(methodsCalled('rooms.history.get')).toHaveLength(2);
    expect(screen.getByText('Not shared')).toBeTruthy(); expect(screen.queryByText(/^Shared at /)).toBeNull();
  });
  it('is a floating panel: Escape closes it and drops a pending confirmation', async () => {
    bridge.setHandler('rooms.history.get', () => NOT_SHARED);
    bridge.setHandler('rooms.history.share', () => SHARED);
    const { container } = render(show()); await openMenu(); await screen.findByText('Not shared');
    // Панель вынесена из шапки (портал): раскрытие не растит саму шапку.
    expect(container.contains(screen.getByRole('group', { name: 'History' }))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Share history…' }));
    expect(screen.getByText(/shared Git files/)).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('group', { name: 'History' })).toBeNull());
    expect(methodsCalled('rooms.history.share')).toHaveLength(0);
    await openMenu(); await screen.findByText('Not shared');
    expect(screen.queryByText(/shared Git files/)).toBeNull();
  });
});
