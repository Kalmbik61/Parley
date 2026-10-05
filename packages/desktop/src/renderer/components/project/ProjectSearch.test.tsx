import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistoryHitView, HistorySearchView } from '@parley/protocol';
import { createFakeBridge, type FakeBridge } from '../../test-utils/fake-bridge.js';
import { ProjectSearch, type SearchTarget } from './ProjectSearch.js';

const PROJECT = '/project';
const hit = (patch: Partial<HistoryHitView> = {}): HistoryHitView => ({ source: 'memory', title: 'PTY tests flake', excerpt: 'PTY tests flake in worktrees', date: null,
  file: '.parley/memory.md', line: 4, id: 'm-001', complete: true, ...patch });
const result = (hits: HistoryHitView[], patch: Partial<HistorySearchView> = {}): HistorySearchView =>
  ({ query: 'pty', scope: 'all', limit: 10, total: hits.length, hits, unavailable: [], ...patch });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

let bridge: FakeBridge;
const onOpen = vi.fn<(target: SearchTarget) => boolean | Promise<boolean>>(() => true);
const show = (patch: { projectPath?: string | null; supported?: boolean; connection?: number } = {}) =>
  <ProjectSearch bridge={bridge} projectPath={patch.projectPath === undefined ? PROJECT : patch.projectPath} supported={patch.supported ?? true}
    connection={patch.connection ?? 1} onOpen={onOpen} />;
const type = (value: string) => fireEvent.change(screen.getByLabelText('Search project history'), { target: { value } });
const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Search' }));
beforeEach(() => { bridge = createFakeBridge(); onOpen.mockClear(); onOpen.mockReturnValue(true); });
afterEach(() => cleanup());

describe('Search tab', () => {
  it('searches only on submit, with the chosen scope and the default limit, and trims the query', async () => {
    bridge.setHandler('history.search', () => result([hit()]));
    render(show());
    expect((screen.getByRole('button', { name: 'Search' }) as HTMLButtonElement).disabled).toBe(true);
    type('  pty  '); expect(bridge.calls).toEqual([]);
    fireEvent.change(screen.getByLabelText('Where'), { target: { value: 'memory' } });
    submit();
    await screen.findByText('PTY tests flake');
    expect(bridge.calls).toMatchObject([{ method: 'history.search', params: { projectPath: PROJECT, query: 'pty', scope: 'memory', limit: 10 } }]);
  });
  it('the default scope is not sent', async () => {
    bridge.setHandler('history.search', () => result([]));
    render(show()); type('x'); submit(); await screen.findByText(/Nothing found/);
    expect(bridge.calls[0]?.params).toEqual({ projectPath: PROJECT, query: 'x', limit: 10 });
  });
  it('groups results by source and shows excerpt, date, file and line', async () => {
    bridge.setHandler('history.search', () => result([
      hit({ source: 'sessions', title: 'Migrated the cache', excerpt: 'All tests pass', file: undefined, line: undefined, id: undefined, workId: 'w-0001', sessionId: 's-01', date: '2026-10-05T12:00:00.000Z' }),
      hit(), hit({ source: 'decisions', title: 'Use sqlite', excerpt: 'Use sqlite for the queue', file: '.parley/decisions/2026-10-05-w-0001-r-01-p-01-rev-01.md', line: 1, id: 'p-01', workId: 'w-0001', roomId: 'r-01', date: '2026-10-05T10:00:00.000Z' }),
    ], { total: 3 }));
    render(show()); type('x'); submit(); await screen.findByText('Use sqlite');
    const sections = screen.getAllByRole('heading', { level: 3 }).map(row => row.textContent);
    expect(sections).toEqual(['Decisions', 'Memory', 'Session results']);
    expect(screen.getByText('PTY tests flake in worktrees')).toBeTruthy();
    expect(screen.getByText(/m-001 · \.parley\/memory\.md:4/)).toBeTruthy();
    expect(screen.getByText(/2026-10-05 · \.parley\/decisions\/.*:1/, { exact: false })).toBeTruthy();
  });
  it('a file hit opens the file on its line; a room hit opens the room; a session hit opens the session', async () => {
    bridge.setHandler('history.search', () => result([
      hit(),
      hit({ source: 'decisions', title: 'Use sqlite', id: 'p-01', file: '.parley/decisions/x.md', line: 1, workId: 'w-0001', roomId: 'r-01' }),
      hit({ source: 'sessions', title: 'Migrated the cache', file: undefined, line: undefined, id: undefined, workId: 'w-0001', sessionId: 's-01' }),
    ]));
    render(show()); type('x'); submit(); await screen.findByText('Migrated the cache');
    fireEvent.click(screen.getByRole('button', { name: 'Open file: PTY tests flake' }));
    expect(onOpen).toHaveBeenLastCalledWith({ kind: 'file', path: '.parley/memory.md', line: 4 });
    fireEvent.click(screen.getByRole('button', { name: 'Open room: Use sqlite' }));
    expect(onOpen).toHaveBeenLastCalledWith({ kind: 'room', workId: 'w-0001', roomId: 'r-01' });
    fireEvent.click(screen.getByRole('button', { name: 'Open file: Use sqlite' }));
    expect(onOpen).toHaveBeenLastCalledWith({ kind: 'file', path: '.parley/decisions/x.md', line: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Open session: Migrated the cache' }));
    expect(onOpen).toHaveBeenLastCalledWith({ kind: 'session', workId: 'w-0001', sessionId: 's-01' });
    expect(screen.queryByRole('button', { name: 'Open file: Migrated the cache' })).toBeNull();
  });
  it('a file of the shared directory opens as a shared-file target without a project path', async () => {
    bridge.setHandler('history.search', () => result([hit({ file: 'memory.md', sharedFile: true })]));
    render(show()); type('x'); submit(); await screen.findByText('PTY tests flake');
    fireEvent.click(screen.getByRole('button', { name: 'Open file: PTY tests flake' }));
    expect(onOpen).toHaveBeenLastCalledWith({ kind: 'shared-file', file: 'memory.md' });
  });
  it('an asynchronous open that fails or finds nothing is reported', async () => {
    bridge.setHandler('history.search', () => result([hit({ file: 'memory.md', sharedFile: true })]));
    render(show()); type('x'); submit(); await screen.findByText('PTY tests flake');
    onOpen.mockRejectedValueOnce(new Error('SECRET'));
    fireEvent.click(screen.getByRole('button', { name: 'Open file: PTY tests flake' }));
    await screen.findByText('The result could not be opened.'); expect(document.body.textContent).not.toContain('SECRET');
    onOpen.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: 'Open file: PTY tests flake' }));
    await screen.findByText(/no longer exists/);
  });
  it('says so when the target no longer exists or cannot be opened', async () => {
    bridge.setHandler('history.search', () => result([hit()]));
    render(show()); type('x'); submit(); await screen.findByText('PTY tests flake');
    onOpen.mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: 'Open file: PTY tests flake' }));
    await screen.findByText(/no longer exists/);
    onOpen.mockImplementationOnce(() => { throw new Error('SECRET'); });
    fireEvent.click(screen.getByRole('button', { name: 'Open file: PTY tests flake' }));
    await screen.findByText('The result could not be opened.'); expect(document.body.textContent).not.toContain('SECRET');
  });
  it('shows unreadable sources, the cut-off count and an empty result', async () => {
    bridge.setHandler('history.search', () => result([hit()], { total: 25, unavailable: ['plans', 'history'] }));
    render(show()); type('x'); submit();
    await screen.findByText('Showing 1 of 25'); expect(screen.getByText(/Plans, Room history/)).toBeTruthy();
  });
  it('a failed or invalid search is visible and sanitised', async () => {
    bridge.setHandler('history.search', () => { throw new Error('SECRET_PATH'); });
    render(show()); type('x'); submit();
    await screen.findByText('The search failed. Try again.'); expect(document.body.textContent).not.toContain('SECRET_PATH');
    bridge.setHandler('history.search', () => ({ nonsense: true } as never));
    submit(); await screen.findByText('The search failed. Try again.');
  });
  it('an old host shows a message and makes no calls', () => {
    render(show({ supported: false }));
    expect(screen.getByText(/does not support history search/)).toBeTruthy(); expect(bridge.calls).toEqual([]);
  });
  it('drops an old reply after the project changed and resets the form', async () => {
    const old = deferred<HistorySearchView>(); bridge.setHandler('history.search', () => old.promise);
    const { rerender } = render(show()); type('x'); submit();
    rerender(show({ projectPath: '/other' }));
    await act(async () => { old.resolve(result([hit({ title: 'Stale hit' })])); });
    expect(screen.queryByText('Stale hit')).toBeNull();
    expect((screen.getByLabelText('Search project history') as HTMLInputElement).value).toBe('');
  });
});
