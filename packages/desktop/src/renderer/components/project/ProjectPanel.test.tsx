import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CapabilitySnapshot } from '@parley/protocol';
import { useHostStore } from '../../store/host.js';
import { useWorksStore } from '../../store/works.js';
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


const mcpSnapshot = (projectPath = PROJECT, revision = 5): CapabilitySnapshot => ({ projectPath, revision,
 columns: { claude: { phase: 'ready', diagnostics: [], mcpAdd: { user: { allowed: true, reason: null }, project: { allowed: true, reason: null }, local: { allowed: true, reason: null } } }, codex: { phase: 'ready', diagnostics: [] } },
 rows: [{ id: 'mcp', kind: 'mcp', name: 'display-name', description: null, separateCopies: false, codex: [], claude: [{ id: 'OPAQUE_NATIVE_ID', scope: 'user', source: null, documentPath: null, description: null, installed: true, enabled: null, status: 'unknown', summary: null, modelAvailable: null, unavailableReason: null, mcpActions: { remove: { allowed: true, reason: null }, check: { allowed: true, reason: null } } }] }],
});
function enableActions() { useHostStore.setState({ status: { state: 'connected', hostVersion: 'fixture', methods: [...METHODS, 'capabilities.mcp.add', 'capabilities.mcp.remove', 'capabilities.mcp.check'] } }); bridge.setHandler('capabilities.get', () => mcpSnapshot()); }

it('sends opaque native target/revision only after confirmation and rejects raw success output', async () => {
 enableActions(); bridge.setHandler('capabilities.mcp.remove', () => ({ outcome: 'ok', code: 'ok', stdout: 'OUTPUT_SECRET' } as never)); const warn = vi.spyOn(console, 'warn');
 render(<ProjectPanel bridge={bridge} projectPath={PROJECT} onOpenChange={vi.fn()} />); await screen.findByText('display-name'); fireEvent.click(screen.getByRole('button', { name: 'Remove…' }));
 expect(bridge.calls.some(call => call.method === 'capabilities.mcp.remove')).toBe(false); fireEvent.click(screen.getByRole('button', { name: 'Remove server' }));
 await screen.findByText('The native response could not be verified'); expect(bridge.calls.find(call => call.method === 'capabilities.mcp.remove')?.params).toEqual({ projectPath: PROJECT, provider: 'claude', presenceId: 'OPAQUE_NATIVE_ID', revision: 5 });
 expect(screen.queryByText('OUTPUT_SECRET')).toBeNull(); expect(warn).not.toHaveBeenCalled();
});

it('ignores late action completion after project/reconnect/revision changes', async () => {
 enableActions(); const pending = deferred<{ outcome: 'failed'; code: 'cli-error' }>(); bridge.setHandler('capabilities.mcp.check', () => pending.promise);
 const view = render(<ProjectPanel bridge={bridge} projectPath={PROJECT} onOpenChange={vi.fn()} />); await screen.findByText('display-name'); fireEvent.click(screen.getByRole('button', { name: 'Check' }));
 await act(async () => { bridge.emit('capabilities.changed', { projectPath: PROJECT, snapshot: mcpSnapshot(PROJECT, 6) }); pending.resolve({ outcome: 'failed', code: 'cli-error' }); });
 expect(screen.queryByText('The native action failed')).toBeNull();
 expect(screen.getByText('Applies to new sessions. Restart running sessions to pick up changes.')).toBeTruthy();
 const other = deferred<{ outcome: 'ok'; code: 'ok' }>(); bridge.setHandler('capabilities.mcp.check', () => other.promise); fireEvent.click(screen.getByRole('button', { name: 'Check' }));
 bridge.setHandler('capabilities.get', () => mcpSnapshot('/other', 1)); view.rerender(<ProjectPanel bridge={bridge} projectPath="/other" onOpenChange={vi.fn()} />);
 await act(async () => { other.resolve({ outcome: 'ok', code: 'ok' }); }); expect(screen.queryByText('Done')).toBeNull();
});


it('drops pending action results on reconnect and accepts a new host action independently', async () => {
 enableActions(); const old = deferred<{ outcome: 'failed'; code: 'cli-error' }>(); bridge.setHandler('capabilities.mcp.check', () => old.promise);
 bridge.setHandler('capabilities.refresh', () => mcpSnapshot(PROJECT, 1));
 render(<ProjectPanel bridge={bridge} projectPath={PROJECT} onOpenChange={vi.fn()} />); await screen.findByText('display-name');
 fireEvent.click(screen.getByRole('button', { name: 'Check' }));
 await act(async () => { useHostStore.setState({ connections: 2 }); });
 await waitFor(() => expect(bridge.calls.some(call => call.method === 'capabilities.refresh')).toBe(true));
 await act(async () => { old.resolve({ outcome: 'failed', code: 'cli-error' }); });
 expect(screen.queryByText('The native action failed')).toBeNull();
 bridge.setHandler('capabilities.mcp.check', () => ({ outcome: 'ok', code: 'ok', status: 'ok' }));
 fireEvent.click(screen.getByRole('button', { name: 'Check' })); await screen.findByText('Done · Connected');
 const calls = bridge.calls.filter(call => call.method === 'capabilities.mcp.check');
 expect(calls.map(call => call.params)).toEqual([
  { projectPath: PROJECT, provider: 'claude', presenceId: 'OPAQUE_NATIVE_ID', revision: 5 },
  { projectPath: PROJECT, provider: 'claude', presenceId: 'OPAQUE_NATIVE_ID', revision: 1 },
 ]);
 expect(bridge.calls.some(call => call.method.startsWith('sessions.'))).toBe(false);
});

it('submits an explicit scoped Add from the form and keeps independent provider outcomes safe', async () => {
 enableActions(); bridge.setHandler('capabilities.mcp.add', params => params.provider === 'claude' ? { outcome: 'ok', code: 'ok' } : { outcome: 'failed', code: 'cli-error' });
 render(<ProjectPanel bridge={bridge} projectPath={PROJECT} onOpenChange={vi.fn()} />); await screen.findByText('display-name');
 fireEvent.click(screen.getByRole('button', { name: 'Add MCP server' }));
 fireEvent.change(screen.getByLabelText('Server name'), { target: { value: 'new-server' } });
 fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'node' } });
 fireEvent.change(screen.getByLabelText('Claude scope'), { target: { value: 'local' } });
 const form = screen.getByRole('form', { name: 'Add MCP server' }); fireEvent.submit(form);
 await screen.findByText('Claude · Done');
 const submitted = bridge.calls.filter(call => call.method === 'capabilities.mcp.add');
 expect(submitted).toHaveLength(1); expect(submitted[0]?.params).toEqual({ projectPath: PROJECT, provider: 'claude', revision: 5, scope: 'local', name: 'new-server', input: { kind: 'stdio', command: 'node', args: [] } });
 expect(bridge.calls.some(call => call.method.startsWith('sessions.'))).toBe(false);
});


import { makeSession, makeWork } from '../../test-utils/work-fixtures.js';
import type { WorksSnapshot } from '@parley/protocol';

it('shows only fresh host-backed selected-provider project active counts, never unknown as zero', async () => {
 enableActions(); useHostStore.setState({ status: { state: 'connected', hostVersion: 'fixture', methods: [...METHODS, 'capabilities.mcp.check', 'works.list'] } });
 bridge.setHandler('capabilities.mcp.check', () => ({ outcome: 'ok', code: 'ok', status: 'ok' }));
 const pending = deferred<WorksSnapshot>(); bridge.setHandler('works.list', () => pending.promise);
 render(<ProjectPanel bridge={bridge} projectPath={PROJECT} onOpenChange={vi.fn()} />); await screen.findByText('display-name'); fireEvent.click(screen.getByRole('button', { name: 'Check' }));
 await screen.findByText('Done · Connected'); expect(screen.queryByText(/0 sessions are running/)).toBeNull();
 await act(async () => { pending.resolve({ branches: {}, entries: [
  makeWork('one', { projectPath: PROJECT, sessions: [makeSession('active-external', 'external'), makeSession('sleeping', 'sleeping', { lifecycle: 'sleeping' }), makeSession('other-provider', 'codex', { provider: 'codex', pid: 22 })] }),
  makeWork('two', { projectPath: PROJECT, sessions: [makeSession('active-host', 'host', { pid: 11 }), makeSession('closed', 'closed', { lifecycle: 'closed' })] }),
  makeWork('foreign', { projectPath: '/foreign', sessions: [makeSession('foreign', 'foreign')] }),
 ] }); });
 await screen.findByText('Applies to new sessions. 2 sessions are running in this project — restart affected sessions to pick up changes.');
 expect(bridge.calls.filter(call => call.method === 'works.list')).toHaveLength(1); expect(bridge.calls.some(call => call.method.startsWith('sessions.'))).toBe(false);
});

it('ignores late old-host session counts and falls back safely on a failed or malformed count', async () => {
 enableActions(); useHostStore.setState({ status: { state: 'connected', hostVersion: 'fixture', methods: [...METHODS, 'capabilities.mcp.check', 'works.list'] } });
 bridge.setHandler('capabilities.mcp.check', () => ({ outcome: 'ok', code: 'ok' }));
 const old = deferred<WorksSnapshot>(); bridge.setHandler('works.list', () => old.promise);
 bridge.setHandler('capabilities.refresh', () => mcpSnapshot(PROJECT, 1));
 render(<ProjectPanel bridge={bridge} projectPath={PROJECT} onOpenChange={vi.fn()} />); await screen.findByText('display-name'); fireEvent.click(screen.getByRole('button', { name: 'Check' })); await screen.findByText('Done');
 await act(async () => { useHostStore.setState({ connections: 2 }); }); await waitFor(() => expect(bridge.calls.some(call => call.method === 'capabilities.refresh')).toBe(true));
 await act(async () => { old.resolve({ entries: [], branches: {} }); }); expect(screen.queryByText(/0 sessions are running/)).toBeNull();
 bridge.setHandler('works.list', () => { throw new Error('COUNT_SECRET'); }); fireEvent.click(screen.getByRole('button', { name: 'Check' })); await screen.findByText('Done');
 await waitFor(() => expect(bridge.calls.filter(call => call.method === 'works.list')).toHaveLength(2));
 expect(document.body.textContent).not.toContain('COUNT_SECRET'); expect(screen.queryByText(/0 sessions are running/)).toBeNull();
 bridge.setHandler('works.list', () => ({ entries: null, branches: {} } as never)); fireEvent.click(screen.getByRole('button', { name: 'Check' }));
 await waitFor(() => expect(bridge.calls.filter(call => call.method === 'works.list')).toHaveLength(3)); expect(screen.queryByText(/0 sessions are running/)).toBeNull();
 bridge.setHandler('works.list', () => ({ entries: [], branches: {} })); fireEvent.click(screen.getByRole('button', { name: 'Check' }));
 await screen.findByText('Applies to new sessions. 0 sessions are running in this project — restart affected sessions to pick up changes.');
});


it('keeps Suggested count live before tab selection and opens only a prepared same-project task context', async () => {
  const names = ['backlog.get', 'backlog.subscribe', 'backlog.unsubscribe', 'backlog.prepareTake', 'backlog.take'];
  useHostStore.setState({ status: { state: 'connected', hostVersion: 'fixture', methods: [...METHODS, ...names] } });
  useWorksStore.setState({ entries: [makeWork('w-01', { projectPath: PROJECT }), makeWork('w-02', { projectPath: '/foreign' })] });
  const value = { projectPath: PROJECT, sharedProjectPath: PROJECT, version: 'v1', file: { relativePath: '.parley/backlog.md' as const, exists: true }, rule: 'ask' as const, diagnostics: [],
    suggestions: [{ id: 'sg-01', kind: 'idea' as const, title: 'Pending', details: '', why: 'Reason', workId: 'w-01', sessionId: 's-01', createdAt: 'now', status: 'pending' as const }],
    items: [{ id: 'b-001', title: 'Backlog task', details: 'Task details', checked: false, section: null }] };
  bridge.setHandler('backlog.subscribe', () => value); bridge.setHandler('backlog.get', () => value);
  bridge.setHandler('backlog.unsubscribe', () => ({ ok: true })); bridge.setHandler('backlog.prepareTake', () => ({ id: 'b-001', snapshot: value }));
  const close = vi.fn(); render(<ProjectPanel bridge={bridge} projectPath={PROJECT} onOpenChange={close} />);
  await screen.findByRole('tab', { name: 'Backlog (1)' });
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Backlog (1)' }), { button: 0 });
  await screen.findByRole('button', { name: 'Take into room…' });
  fireEvent.click(screen.getByRole('button', { name: 'Take into room…' }));
  await waitFor(() => expect(useUiStore.getState().dialogs.newSession.backlog).toEqual({ projectPath: PROJECT, id: 'b-001', version: 'v1', task: 'Backlog task\n\nTask details' }));
  expect(useUiStore.getState().dialogs.newSession.work).toEqual({ projectPath: PROJECT, workId: 'w-01' }); expect(close).toHaveBeenCalledWith(false);
  expect(bridge.calls.some(row => row.method === 'backlog.take')).toBe(false);
});
