import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CapabilitySnapshot } from '@parley/protocol';
import { useHostStore } from '../../store/host.js';
import { useUiStore } from '../../store/ui.js';
import { createFakeBridge, type FakeBridge } from '../../test-utils/fake-bridge.js';
import { openParleyEditor } from '../../sidebar/SectionMenu.js';
import { ProjectPanel } from './ProjectPanel.js';

vi.mock('../../sidebar/SectionMenu.js', () => ({ openParleyEditor: vi.fn() }));
const PROJECT = '/project';
const METHODS = ['capabilities.get', 'capabilities.refresh'];
const snapshot = (projectPath = PROJECT, revision = 1, name = 'review'): CapabilitySnapshot => ({ projectPath, revision,
  columns: { claude: { phase: 'ready', diagnostics: [] }, codex: { phase: 'loading', diagnostics: [] } },
  rows: [{ id: `row-${name}`, kind: 'skill', name, description: null, separateCopies: false, claude: [{ id: `skill-${name}`,
    scope: 'project', source: null, documentPath: `/native/${name}/SKILL.md`, description: 'Safe metadata', installed: true,
    enabled: true, status: 'ok', summary: null, modelAvailable: true, unavailableReason: null }], codex: [] }],
});
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
let bridge: FakeBridge;
beforeEach(() => {
  bridge = createFakeBridge(); vi.clearAllMocks();
  useHostStore.setState({ status: { state: 'connected', hostVersion: 'fixture', methods: METHODS }, connections: 1 });
  useUiStore.getState().closeProjectPanel(); useUiStore.getState().closeRestartHostDialog();
  bridge.setHandler('capabilities.get', () => snapshot());
  bridge.setHandler('capabilities.refresh', () => snapshot(PROJECT, 2));
  vi.spyOn(bridge.app, 'parleyMd').mockResolvedValue({ exists: true, created: false });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('one project panel lifecycle', () => {
  it('subscribes before get, keeps newer partial events and updates only the requested project', async () => {
    const pending = deferred<CapabilitySnapshot>(); bridge.setHandler('capabilities.get', () => pending.promise);
    const on = vi.spyOn(bridge, 'on'); const call = vi.spyOn(bridge, 'call');
    render(<ProjectPanel bridge={bridge} projectPath={PROJECT} onOpenChange={vi.fn()} />);
    expect(on.mock.invocationCallOrder[0]).toBeLessThan(call.mock.invocationCallOrder[0]!);
    await act(async () => { bridge.emit('capabilities.changed', { projectPath: PROJECT, snapshot: snapshot(PROJECT, 3, 'newer') }); });
    expect(screen.getByText('newer')).toBeTruthy(); expect(screen.getAllByText('Loading…').length).toBeGreaterThan(0);
    await act(async () => { bridge.emit('capabilities.changed', { projectPath: '/other', snapshot: snapshot('/other', 4, 'foreign') }); pending.resolve(snapshot(PROJECT, 1, 'older')); });
    expect(screen.queryByText('older')).toBeNull(); expect(screen.queryByText('foreign')).toBeNull();
  });
  it('refreshes on button and reopen, unsubscribes on close, and never restarts sessions', async () => {
    const unsubscribe = vi.fn(); const realOn = bridge.on;
    vi.spyOn(bridge, 'on').mockImplementation((event, listener) => { const off = realOn(event, listener); return () => { unsubscribe(); off(); }; });
    const props = { bridge, onOpenChange: vi.fn() }; const { rerender } = render(<ProjectPanel {...props} projectPath={PROJECT} />);
    await screen.findByText('review'); fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(bridge.calls.filter(call => call.method === 'capabilities.refresh')).toHaveLength(1));
    rerender(<ProjectPanel {...props} projectPath={null} />); expect(unsubscribe).toHaveBeenCalledTimes(1);
    rerender(<ProjectPanel {...props} projectPath={PROJECT} />);
    await waitFor(() => expect(bridge.calls.filter(call => call.method === 'capabilities.refresh')).toHaveLength(2));
    expect(bridge.calls.some(call => call.method.startsWith('sessions.'))).toBe(false);
    expect(screen.getByText('Refresh updates this panel. Running sessions keep their current settings.')).toBeTruthy();
  });
  it('ignores old project and connection replies, including a higher old-host revision', async () => {
    const old = deferred<CapabilitySnapshot>(); bridge.setHandler('capabilities.get', () => old.promise);
    bridge.setHandler('capabilities.refresh', params => snapshot(params.projectPath, 1, 'fresh-host'));
    const props = { bridge, onOpenChange: vi.fn() }; const { rerender } = render(<ProjectPanel {...props} projectPath={PROJECT} />);
    rerender(<ProjectPanel {...props} projectPath="/other" />);
    await act(async () => { old.resolve(snapshot(PROJECT, 99, 'old-project')); });
    expect(screen.queryByText('old-project')).toBeNull();
    await act(async () => { useHostStore.setState({ connections: 2 }); });
    await screen.findByText('fresh-host'); expect(bridge.calls.at(-1)?.params).toEqual({ projectPath: '/other' });
  });
  it('old host offers existing restart confirmation without invoking unsupported methods', async () => {
    useHostStore.setState({ status: { state: 'connected', hostVersion: 'old', methods: [] } });
    const close = vi.fn(); render(<ProjectPanel bridge={bridge} projectPath={PROJECT} onOpenChange={close} />);
    expect(screen.getByText(/does not support the capabilities panel/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Restart host…' }));
    expect(close).toHaveBeenCalledWith(false); expect(useUiStore.getState().dialogs.restartHost).toBe(true);
    expect(bridge.calls).toHaveLength(0); expect(bridge.hostActions).toHaveLength(0);
  });
  it('safe failure permits retry and does not render or log raw error text', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    bridge.setHandler('capabilities.get', () => { throw new Error('FIXTURE_SECRET'); });
    render(<ProjectPanel bridge={bridge} projectPath={PROJECT} onOpenChange={vi.fn()} />);
    await screen.findByRole('alert'); expect(document.body.textContent).not.toContain('FIXTURE_SECRET'); expect(warn).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' })); await screen.findByText('review');
    warn.mockRestore();
  });
  it('PARLEY status is read-only; Create is explicit and opens the existing editor', async () => {
    const status = vi.mocked(bridge.app.parleyMd); status.mockResolvedValueOnce({ exists: false, created: false }).mockResolvedValueOnce({ exists: true, created: true });
    const close = vi.fn(); render(<ProjectPanel bridge={bridge} projectPath={PROJECT} onOpenChange={close} />);
    const button = await screen.findByRole('button', { name: 'Create PARLEY.md' });
    expect(status.mock.calls).toEqual([[PROJECT, false]]); expect(openParleyEditor).not.toHaveBeenCalled();
    fireEvent.click(button); await waitFor(() => expect(openParleyEditor).toHaveBeenCalledWith(PROJECT));
    expect(status.mock.calls).toEqual([[PROJECT, false], [PROJECT, true]]); expect(close).toHaveBeenCalledWith(false);
  });
  it('Open rechecks an existing PARLEY file without creating it; late status from another project is ignored', async () => {
    const old = deferred<{ exists: boolean; created: boolean }>(); const status = vi.mocked(bridge.app.parleyMd);
    status.mockImplementation(project => project === PROJECT ? old.promise : Promise.resolve({ exists: true, created: false }));
    const props = { bridge, onOpenChange: vi.fn() }; const { rerender } = render(<ProjectPanel {...props} projectPath={PROJECT} />);
    rerender(<ProjectPanel {...props} projectPath="/other" />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open PARLEY.md' })).not.toHaveProperty('disabled', true));
    await act(async () => { old.resolve({ exists: false, created: false }); }); expect(screen.queryByRole('button', { name: 'Create PARLEY.md' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open PARLEY.md' }));
    await waitFor(() => expect(openParleyEditor).toHaveBeenCalledWith('/other'));
    expect(status.mock.calls.some(([, create]) => create)).toBe(false);
  });
});

it('a late failed get cannot replace a newer successful event with an error', async () => {
 const pending = deferred<CapabilitySnapshot>(); bridge.setHandler('capabilities.get', () => pending.promise);
 render(<ProjectPanel bridge={bridge} projectPath={PROJECT} onOpenChange={vi.fn()} />);
 await act(async () => { bridge.emit('capabilities.changed', { projectPath: PROJECT, snapshot: snapshot(PROJECT, 4, 'latest') }); pending.reject(new Error('FIXTURE_SECRET')); });
 expect(screen.getByText('latest')).toBeTruthy(); expect(screen.queryByRole('alert')).toBeNull();
});
it('reconnect accepts a fresh low revision and discards an older host reply for the same project', async () => {
 const pending = deferred<CapabilitySnapshot>(); bridge.setHandler('capabilities.get', () => pending.promise);
 bridge.setHandler('capabilities.refresh', () => snapshot(PROJECT, 1, 'fresh-host'));
 render(<ProjectPanel bridge={bridge} projectPath={PROJECT} onOpenChange={vi.fn()} />);
 await act(async () => { useHostStore.setState({ connections: 2 }); }); await screen.findByText('fresh-host');
 await act(async () => { pending.resolve(snapshot(PROJECT, 99, 'old-host')); });
 expect(screen.queryByText('old-host')).toBeNull(); expect(screen.getByText('fresh-host')).toBeTruthy();
});
it('rejects unexpected raw response fields without printing or rendering them', async () => {
 bridge.setHandler('capabilities.get', () => Object.assign(snapshot(), { rawConfig: 'FIXTURE_SECRET' }));
 const warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); const error = vi.spyOn(console, 'error').mockImplementation(() => {});
 render(<ProjectPanel bridge={bridge} projectPath={PROJECT} onOpenChange={vi.fn()} />);
 await screen.findByRole('alert'); expect(document.body.textContent).not.toContain('FIXTURE_SECRET');
 expect(warn).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
});

it('a malformed late response cannot invalidate newer safe metadata', async () => {
 const pending = deferred<CapabilitySnapshot>(); bridge.setHandler('capabilities.get', () => pending.promise);
 render(<ProjectPanel bridge={bridge} projectPath={PROJECT} onOpenChange={vi.fn()} />);
 await act(async () => { bridge.emit('capabilities.changed', { projectPath: PROJECT, snapshot: snapshot(PROJECT, 4, 'latest') });
  pending.resolve(Object.assign(snapshot(PROJECT, 1), { rawConfig: 'FIXTURE_SECRET' })); });
 expect(screen.getByText('latest')).toBeTruthy(); expect(screen.queryByRole('alert')).toBeNull();
 expect(document.body.textContent).not.toContain('FIXTURE_SECRET');
});
