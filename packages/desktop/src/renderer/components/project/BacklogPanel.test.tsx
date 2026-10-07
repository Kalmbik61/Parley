import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BacklogSnapshot } from '@parley/protocol';
import { BacklogPanel } from './BacklogPanel.js';
import type { BacklogBridge, BacklogPanelProps } from './BacklogPanel.js';
const project = '/project';
const snapshot = (projectPath = project, version = 'v1'): BacklogSnapshot => ({ projectPath, sharedProjectPath: projectPath,
  version, file: { relativePath: '.parley/backlog.md', exists: true }, rule: 'problems', diagnostics: [],
  suggestions: [{ id: 'sg-01', kind: 'idea', title: 'Suggestion', details: 'Suggested details', why: 'Observed reason', workId: 'w-01', sessionId: 's-01', createdAt: 'now', status: 'pending' }],
  items: [{ id: 'b-001', title: 'Open item', details: 'Existing details', checked: false, section: 'Bugs' },
    { id: 'b-002', title: 'Taken item', details: '', checked: false, section: 'Debt', taken: 'w-01/r-01' },
    { id: 'b-003', title: 'Done item', details: '', checked: true, section: 'Bugs', done: '2026-10-04' },
    { id: null, title: 'Handwritten item', details: '', checked: false, section: null }] });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (value: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
function fixture(response: BacklogSnapshot = snapshot()) {
  const call = vi.fn().mockResolvedValue(response);
  let listener: ((event: { projectPath: string; unavailable?: true }) => void) | undefined;
  const off = vi.fn();
  const bridge = { call, on: vi.fn((_event, next) => { listener = next; return off; }) } as BacklogBridge;
  const props: BacklogPanelProps = { bridge, projectPath: project, supported: true, connection: 1, onOpenFile: vi.fn().mockResolvedValue(undefined), onTake: vi.fn() };
  return { call, props, off, changed: (event: { projectPath: string; unavailable?: true }) => listener?.(event) };
}
afterEach(cleanup);
describe('BacklogPanel', () => {
  it('shows sections, pending reasons/authors, and open/taken/done filters', async () => {
    const { props } = fixture(); render(<BacklogPanel {...props} />);
    await screen.findByText('Open item'); expect(screen.getByText('Suggested (1)')).toBeTruthy();
    expect(screen.getByText('Observed reason')).toBeTruthy(); expect(screen.getByText('w-01/s-01')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Bugs' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Show items'), { target: { value: 'taken' } });
    expect(screen.queryByText('Open item')).toBeNull(); expect(screen.getByText('Taken item')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Show items'), { target: { value: 'done' } });
    expect(screen.getByText('Done item')).toBeTruthy(); expect(screen.queryByText('Taken item')).toBeNull();
  });
  it('edits a suggestion before acceptance and projects the fresh response', async () => {
    const { props, call } = fixture(); render(<BacklogPanel {...props} />); await screen.findByText('Suggestion');
    fireEvent.click(screen.getByRole('button', { name: 'Edit & add' }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Human title' } });
    fireEvent.change(screen.getByLabelText('Details'), { target: { value: 'Human details' } });
    const fresh = snapshot(project, 'v2'); fresh.suggestions = []; fresh.items.push({ id: 'b-004', title: 'Human title', details: 'Human details', checked: false, section: null });
    call.mockResolvedValueOnce(fresh);
    fireEvent.click(within(screen.getByLabelText('Title').closest('form')!).getByRole('button', { name: 'Add' }));
    await screen.findByText('Suggested (0)'); expect(screen.queryByLabelText('Title')).toBeNull();
    expect(call).toHaveBeenLastCalledWith('backlog.suggestions.accept', { projectPath: project, id: 'sg-01', title: 'Human title', details: 'Human details' });
  });
  it('adds human input with the displayed version and changes the rule without inferred defaults', async () => {
    const { props, call } = fixture(); render(<BacklogPanel {...props} />); await screen.findByText('Open item');
    fireEvent.click(screen.getByRole('button', { name: 'Add item' }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Human item' } });
    fireEvent.change(screen.getByLabelText('Section'), { target: { value: 'Ideas' } });
    fireEvent.click(within(screen.getByLabelText('Title').closest('form')!).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(screen.queryByLabelText('Title')).toBeNull());
    expect(call).toHaveBeenLastCalledWith('backlog.add', { projectPath: project, title: 'Human item', details: '', section: 'Ideas', version: 'v1' });
    fireEvent.change(screen.getByLabelText('Agent suggestions'), { target: { value: 'ask' } });
    await waitFor(() => expect(call).toHaveBeenLastCalledWith('backlog.preferences.set', { projectPath: project, rule: 'ask' }));
  });
  it('opens creation with the selected item/task/version and does not mark taken before success', async () => {
    const { props, call } = fixture(); render(<BacklogPanel {...props} />); await screen.findByText('Open item');
    call.mockResolvedValueOnce({ id: 'b-001', snapshot: snapshot() });
    fireEvent.click(screen.getAllByRole('button', { name: 'Take into room…' })[0]!);
    await waitFor(() => expect(props.onTake).toHaveBeenCalledTimes(1));
    expect(props.onTake).toHaveBeenCalledWith(project, expect.objectContaining({ id: 'b-001', title: 'Open item', details: 'Existing details' }), 'v1', 0);
    expect(call.mock.calls.some(args => args[0] === 'backlog.take')).toBe(false);
    expect(screen.getAllByRole('button', { name: 'Take into room…' })[1]!.hasAttribute('disabled')).toBe(true);
  });
  it('retains the editor on conflict and never renders raw error content', async () => {
    const { props, call } = fixture(); render(<BacklogPanel {...props} />); await screen.findByText('Open item');
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]!);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Unsent edit' } });
    call.mockRejectedValueOnce(new Error('secret raw parser exception'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('alert'); expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Unsent edit');
    expect(screen.queryByText('secret raw parser exception')).toBeNull();
    expect(call).toHaveBeenLastCalledWith('backlog.update', { projectPath: project, id: 'b-001', version: 'v1', patch: { title: 'Unsent edit', details: 'Existing details' } });
  });
  it('ignores stale project/connection replies and refuses unsupported hosts without calls', async () => {
    const pending = deferred<BacklogSnapshot>(); const { props, call } = fixture(); call.mockReturnValueOnce(pending.promise);
    const { rerender } = render(<BacklogPanel {...props} />);
    call.mockImplementation(async (method: string, params: { projectPath: string }) => method === 'backlog.unsubscribe' ? { ok: true } : { ...snapshot(params.projectPath), items: [{ id: 'b-001', title: 'Other project', details: '', checked: false, section: null }] });
    rerender(<BacklogPanel {...props} projectPath="/other" connection={2} />); await screen.findByText('Other project');
    await act(async () => pending.resolve(snapshot())); expect(screen.queryByText('Open item')).toBeNull();
    const count = call.mock.calls.filter(args => args[0] !== 'backlog.unsubscribe').length; rerender(<BacklogPanel {...props} supported={false} />);
    expect(screen.getByText('Backlog is unavailable on this host.')).toBeTruthy(); expect(call.mock.calls.filter(args => args[0] !== 'backlog.unsubscribe')).toHaveLength(count);
  });
  it('addresses handwritten rows by their original full-snapshot index and exact version', async () => {
    const { props, call } = fixture(); render(<BacklogPanel {...props} />); await screen.findByText('Handwritten item');
    fireEvent.click(screen.getByLabelText('Handwritten item'));
    await waitFor(() => expect(call).toHaveBeenLastCalledWith('backlog.update', { projectPath: project, index: 3, version: 'v1', patch: { checked: true } }));
  });
  it('opens the fixed backlog file callback and surfaces safe failures', async () => {
    const { props } = fixture(); vi.mocked(props.onOpenFile).mockRejectedValue(new Error('/secret')); render(<BacklogPanel {...props} />);
    await screen.findByText('Open item'); fireEvent.click(screen.getByRole('button', { name: 'Open file' }));
    await screen.findByRole('alert'); expect(props.onOpenFile).toHaveBeenCalledWith(project); expect(screen.queryByText('/secret')).toBeNull();
  });
  it('subscribes before the first snapshot, refreshes changes, and unsubscribes on close', async () => {
    const { props, call, changed, off } = fixture(); const { unmount } = render(<BacklogPanel {...props} />);
    await screen.findByText('Open item');
    expect(vi.mocked(props.bridge.on).mock.invocationCallOrder[0]).toBeLessThan(call.mock.invocationCallOrder[0]!);
    expect(call).toHaveBeenNthCalledWith(1, 'backlog.subscribe', { projectPath: project });
    const next = snapshot(project, 'v2'); next.suggestions = [];
    call.mockResolvedValueOnce(next); act(() => changed({ projectPath: project }));
    await screen.findByText('Suggested (0)');
    expect(call).toHaveBeenLastCalledWith('backlog.get', { projectPath: project });
    const before = call.mock.calls.length; act(() => changed({ projectPath: '/other' })); expect(call).toHaveBeenCalledTimes(before);
    unmount(); expect(off).toHaveBeenCalledOnce(); expect(call).toHaveBeenLastCalledWith('backlog.unsubscribe', { projectPath: project });
  });
  it('watch failure preserves an explicit manual snapshot and does not imply live freshness', async () => {
    const { props, call, changed } = fixture(); call.mockRejectedValueOnce(new Error('private watch path'));
    render(<BacklogPanel {...props} />); await screen.findByText('Open item');
    expect(screen.getByText('Live backlog updates are unavailable. Use Refresh to read current changes.')).toBeTruthy();
    expect(call).toHaveBeenNthCalledWith(2, 'backlog.get', { projectPath: project });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(call).toHaveBeenLastCalledWith('backlog.subscribe', { projectPath: project }));
    await waitFor(() => expect(screen.queryByText('Live backlog updates are unavailable. Use Refresh to read current changes.')).toBeNull());
    act(() => changed({ projectPath: project, unavailable: true }));
    expect(screen.getByText('Live backlog updates are unavailable. Use Refresh to read current changes.')).toBeTruthy();
    expect(screen.queryByText('private watch path')).toBeNull();
  });
  it('an invalidation during a mutation cannot discard its fresh response or leave the editor open', async () => {
    const { props, call, changed } = fixture(); render(<BacklogPanel {...props} />); await screen.findByText('Open item');
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]!);
    const pending = deferred<BacklogSnapshot>(); call.mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const before = call.mock.calls.length; act(() => changed({ projectPath: project })); expect(call).toHaveBeenCalledTimes(before);
    await act(async () => pending.resolve(snapshot(project, 'v2')));
    await waitFor(() => expect(screen.queryByLabelText('Title')).toBeNull());
    expect(call).toHaveBeenLastCalledWith('backlog.get', { projectPath: project });
  });
  it('prepare failure prevents dialog creation and successful handwritten preparation uses the actual returned ID', async () => {
    const { props, call } = fixture(); render(<BacklogPanel {...props} />); await screen.findByText('Handwritten item');
    call.mockRejectedValueOnce(new Error('raw conflict'));
    fireEvent.click(screen.getAllByRole('button', { name: 'Take into room…' }).at(-1)!);
    await screen.findByRole('alert'); expect(props.onTake).not.toHaveBeenCalled();
    const fresh = snapshot(project, 'v2'); fresh.items[3]!.id = 'b-010';
    call.mockResolvedValueOnce({ id: 'b-010', snapshot: fresh });
    fireEvent.click(screen.getAllByRole('button', { name: 'Take into room…' }).at(-1)!);
    await waitFor(() => expect(props.onTake).toHaveBeenCalledWith(project, expect.objectContaining({ id: 'b-010' }), 'v2', 3));
    expect(call).toHaveBeenLastCalledWith('backlog.prepareTake', { projectPath: project, index: 3, version: 'v1' });
  });

  it('a delayed subscribe reply cannot erase a newer watcher failure and Refresh resubscribes', async () => {
    const { props, call, changed } = fixture();
    const pending = deferred<BacklogSnapshot>(); call.mockReturnValueOnce(pending.promise);
    render(<BacklogPanel {...props} />);
    act(() => changed({ projectPath: project, unavailable: true }));
    await act(async () => pending.resolve(snapshot()));
    await screen.findByText('Open item');
    expect(screen.getByText('Live backlog updates are unavailable. Use Refresh to read current changes.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(call).toHaveBeenLastCalledWith('backlog.subscribe', { projectPath: project }));
    await waitFor(() => expect(screen.queryByText('Live backlog updates are unavailable. Use Refresh to read current changes.')).toBeNull());
  });

});
