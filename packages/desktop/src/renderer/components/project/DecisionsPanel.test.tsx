import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DecisionRef, DecisionsListResult } from '@parley/protocol';
import { createFakeBridge, type FakeBridge } from '../../test-utils/fake-bridge.js';
import { DecisionsPanel } from './DecisionsPanel.js';

const PROJECT = '/project';
const ref = (patch: Partial<DecisionRef> = {}): DecisionRef => ({
  file: '2026-10-05-w-0001-r-01-p-01-rev-02.md', workId: 'w-0001', roomId: 'r-01', proposalId: 'p-01', rev: 2,
  acceptedAt: '2026-10-05T10:00:00.000Z', title: 'Use sqlite', kind: 'decision', state: 'accepted', openable: true, ...patch,
});
const list = (decisions: DecisionRef[], patch: Partial<DecisionsListResult> = {}): DecisionsListResult =>
  ({ decisions, total: decisions.length, partial: false, errors: [], ...patch });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

let bridge: FakeBridge;
const onOpen = vi.fn<(project: string, file: string) => Promise<void>>(async () => {});
const show = (patch: { projectPath?: string | null; supported?: boolean; connection?: number } = {}) =>
  <DecisionsPanel bridge={bridge} projectPath={patch.projectPath === undefined ? PROJECT : patch.projectPath}
    supported={patch.supported ?? true} connection={patch.connection ?? 1} onOpen={onOpen} />;
beforeEach(() => { bridge = createFakeBridge(); onOpen.mockClear(); onOpen.mockResolvedValue(undefined); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('Decisions tab', () => {
  it('lists accepted decisions and opens exactly the clicked revision file', async () => {
    const older = ref({ file: '2026-10-04-w-0001-r-01-p-01-rev-01.md', rev: 1, title: 'Use sqlite (older)' });
    bridge.setHandler('decisions.list', () => list([ref(), older]));
    render(show());
    await screen.findByText('Use sqlite');
    expect(screen.getAllByText('Accepted')).toHaveLength(2);
    expect(screen.getByText(/w-0001 · r-01 · p-01 · revision 2 · 2026-10-05/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open accepted revision: Use sqlite (older)' }));
    expect(onOpen).toHaveBeenCalledTimes(1); expect(onOpen).toHaveBeenCalledWith(PROJECT, older.file);
    fireEvent.click(screen.getByRole('button', { name: 'Open accepted revision: Use sqlite' }));
    expect(onOpen).toHaveBeenLastCalledWith(PROJECT, ref().file);
  });
  it('shows decisions of a deleted workspace as openable, and edited, unverified or pending files as not openable', async () => {
    bridge.setHandler('decisions.list', () => list([
      ref({ file: '2026-10-05-w-0001-r-01-p-01-rev-00.md', title: 'Retained one', state: 'retained' }),
      ref({ file: '2026-10-05-w-0001-r-01-p-02-rev-00.md', proposalId: 'p-02', title: 'Edited one', state: 'edited', openable: false }),
      ref({ file: '2026-10-05-w-0001-r-01-p-03-rev-00.md', proposalId: 'p-03', title: 'Foreign one', state: 'unverified', openable: false }),
      ref({ file: '2026-10-05-w-0001-r-01-p-04-rev-00.md', proposalId: 'p-04', title: 'Waiting one', state: 'pending', openable: false, acceptedAt: null }),
    ]));
    render(show());
    await screen.findByText('Retained one');
    expect(screen.getByText('Accepted · workspace deleted')).toBeTruthy();
    expect(screen.getByText('Edited after acceptance')).toBeTruthy(); expect(screen.getByText('Unverified file')).toBeTruthy();
    expect(screen.getByText('Export pending · not written yet')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Open accepted revision/ })).toHaveLength(1);
  });
  it('filters through the host after a short pause and shows the empty-filter message', async () => {
    const calls: unknown[] = [];
    bridge.setHandler('decisions.list', params => { calls.push(params); return list(params.query === 'zzz' ? [] : [ref()]); });
    render(show()); await screen.findByText('Use sqlite');
    fireEvent.change(screen.getByLabelText('Filter decisions'), { target: { value: ' zzz ' } });
    await screen.findByText('No decisions match this filter.');
    expect(calls).toEqual([{ projectPath: PROJECT, limit: 50 }, { projectPath: PROJECT, query: 'zzz', limit: 50 }]);
  });
  it('makes a partial result and read errors visible without hiding the readable decisions', async () => {
    bridge.setHandler('decisions.list', () => list([ref()], { partial: true, errors: [{ code: 'file-unreadable', count: 2 }, { code: 'scan-limit', count: 1 }, { code: 'file-unrecognized', count: 1 }] }));
    render(show());
    await screen.findByText('Use sqlite');
    expect(screen.getByText('Part of the journal could not be read, so this list may be incomplete.')).toBeTruthy();
    expect(screen.getByText('2 journal files could not be read.')).toBeTruthy();
    expect(screen.getByText('Only the newest files were read.')).toBeTruthy();
    expect(screen.getByText('1 file with an unrecognized name was ignored.')).toBeTruthy();
  });
  it('safe failure and retry through Refresh; raw error text is never rendered', async () => {
    let fail = true;
    bridge.setHandler('decisions.list', () => { if (fail) throw new Error('FIXTURE_SECRET /private/path'); return list([ref()]); });
    render(show());
    await screen.findByRole('alert'); expect(document.body.textContent).not.toContain('FIXTURE_SECRET');
    fail = false; fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByText('Use sqlite'); expect(screen.queryByRole('alert')).toBeNull();
  });
  it('an invalid host answer is a load failure, not rendered content', async () => {
    bridge.setHandler('decisions.list', () => ({ decisions: [{ ...ref(), file: '../escape.md' }], total: 1, partial: false, errors: [] }));
    render(show());
    await screen.findByRole('alert'); expect(screen.queryByText('Use sqlite')).toBeNull();
  });
  it('ignores replies for an old project or connection', async () => {
    const old = deferred<DecisionsListResult>();
    bridge.setHandler('decisions.list', params => params.projectPath === PROJECT ? old.promise : list([ref({ title: 'Other project' })]));
    const { rerender } = render(show());
    rerender(show({ projectPath: '/other' }));
    await screen.findByText('Other project');
    await act(async () => { old.resolve(list([ref({ title: 'Old project' })])); });
    expect(screen.queryByText('Old project')).toBeNull();
    const stale = deferred<DecisionsListResult>(); let second = false;
    bridge.setHandler('decisions.list', () => { if (second) return list([ref({ title: 'Fresh connection' })]); second = true; return stale.promise; });
    rerender(show({ projectPath: '/third', connection: 2 })); rerender(show({ projectPath: '/third', connection: 3 }));
    await screen.findByText('Fresh connection');
    await act(async () => { stale.resolve(list([ref({ title: 'Stale connection' })])); });
    expect(screen.queryByText('Stale connection')).toBeNull();
  });
  it('an old host gets a message and no call', () => {
    render(show({ supported: false }));
    expect(screen.getByText(/does not support the decisions list/)).toBeTruthy(); expect(bridge.calls).toHaveLength(0);
  });
  it('a failed open is a fixed message next to the row', async () => {
    bridge.setHandler('decisions.list', () => list([ref()]));
    onOpen.mockRejectedValue(new Error('/private editor error'));
    render(show()); await screen.findByText('Use sqlite');
    fireEvent.click(screen.getByRole('button', { name: /Open accepted revision/ }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('The accepted revision could not be opened.'));
    expect(document.body.textContent).not.toContain('/private editor error');
  });
  it('says when the list is cut by the limit', async () => {
    bridge.setHandler('decisions.list', () => list([ref()], { total: 120 }));
    render(show()); await screen.findByText('Showing 1 of 120');
  });
});
