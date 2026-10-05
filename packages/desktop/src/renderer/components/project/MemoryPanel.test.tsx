import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryItemView, MemorySnapshot } from '@parley/protocol';
import { encodeIpcError } from '../../../shared/ipc-error.js';
import { createFakeBridge, type FakeBridge } from '../../test-utils/fake-bridge.js';
import { MemoryPanel } from './MemoryPanel.js';

const PROJECT = '/project';
const item = (patch: Partial<MemoryItemView> = {}): MemoryItemView => ({ id: 'm-001', kind: 'lesson', fact: 'PTY tests flake in long-path worktrees', details: '',
  state: 'current', author: 'agent', by: 's-02', onRequest: false, amended: false, ...patch });
const snap = (patch: Partial<MemorySnapshot> = {}): MemorySnapshot => ({ projectPath: PROJECT, file: { relativePath: '.parley/memory.md', exists: true }, version: 'v1',
  items: [], suggestions: [], undoable: [], diagnostics: [], ...patch });
const suggestion = { id: 'ms-01', kind: 'lesson' as const, fact: 'Compare flaky tests with a baseline run', details: 'Run it on master first.', why: 'Seen twice',
  workId: 'w-0001', sessionId: 's-03', createdAt: '2026-10-05T10:00:00.000Z' };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

let bridge: FakeBridge;
const onOpenFile = vi.fn<(path: string) => void>();
const onCount = vi.fn<(count: number) => void>();
const show = (patch: { projectPath?: string | null; supported?: boolean; connection?: number } = {}) =>
  <MemoryPanel bridge={bridge} projectPath={patch.projectPath === undefined ? PROJECT : patch.projectPath} supported={patch.supported ?? true}
    connection={patch.connection ?? 1} onOpenFile={onOpenFile} onCount={onCount} />;
const methods = () => bridge.calls.map(row => row.method);
beforeEach(() => { bridge = createFakeBridge(); onOpenFile.mockClear(); onCount.mockClear(); });
afterEach(() => cleanup());

describe('Memory tab: entries and provenance', () => {
  it('shows entries by section with author, request and edit marks, and keeps hand-written entries read-only', async () => {
    bridge.setHandler('memory.get', () => snap({ items: [
      item(),
      item({ id: 'm-002', kind: 'fact', fact: 'Build with pnpm', author: 'human', by: undefined, amended: true }),
      item({ id: 'm-003', kind: 'agreement', fact: 'Close sessions with consent', onRequest: true }),
      item({ id: null, kind: 'fact', fact: 'Hand written line', author: 'unknown', by: undefined }),
    ] }));
    render(show());
    await screen.findByText('Build with pnpm');
    for (const heading of ['Fact', 'Lesson', 'Agreement']) expect(screen.getAllByText(heading).length).toBeGreaterThan(0);
    expect(screen.getByText('m-001 · Agent s-02')).toBeTruthy();
    expect(screen.getByText('m-002 · You · Edited by you')).toBeTruthy();
    expect(screen.getByText(/Agent says you asked for this/)).toBeTruthy();
    expect(screen.getByText('Hand-written')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit: Build with pnpm' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit: Hand written line' })).toBeNull();
    expect(methods()).toEqual(['memory.get']);
  });
  it('an empty project explains where entries come from', async () => {
    bridge.setHandler('memory.get', () => snap({ version: 'missing', file: { relativePath: '.parley/memory.md', exists: false } }));
    render(show());
    await screen.findByText(/No memory entries yet/); expect(screen.getByText('No suggestions waiting.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open file' })).toHaveProperty('disabled', true);
  });
  it('opens memory.md through the callback with its project-relative path', async () => {
    bridge.setHandler('memory.get', () => snap({ items: [item()] }));
    render(show()); await screen.findByText('PTY tests flake in long-path worktrees');
    fireEvent.click(screen.getByRole('button', { name: 'Open file' }));
    expect(onOpenFile).toHaveBeenCalledWith('.parley/memory.md');
  });
});

describe('Memory tab: Suggested', () => {
  it('Add accepts as is, Edit & add sends the edited text, Dismiss drops the suggestion; the count follows', async () => {
    const second = { ...suggestion, id: 'ms-02', fact: 'Second suggestion', details: '' };
    let current = snap({ suggestions: [suggestion, second] });
    bridge.setHandler('memory.get', () => current);
    bridge.setHandler('memory.accept', params => { current = snap({ version: 'v2', suggestions: current.suggestions.filter(row => row.id !== params.id), items: [item({ fact: params.fact ?? suggestion.fact })] }); return current; });
    bridge.setHandler('memory.dismiss', params => { current = snap({ suggestions: current.suggestions.filter(row => row.id !== params.id) }); return current; });
    render(show());
    await screen.findByText('Suggested (2)'); expect(onCount).toHaveBeenLastCalledWith(2);
    expect(screen.getAllByText('Why: Seen twice')).toHaveLength(2); expect(screen.getAllByText('Suggested by s-03', { exact: false })).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit & add' })[0]!);
    const field = screen.getByLabelText('Fact') as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'Compare flaky tests with a master run' } });
    fireEvent.click(within(screen.getByRole('form', { name: 'Memory' })).getByRole('button', { name: 'Add' }));
    await screen.findByText('Suggested (1)');
    expect(bridge.calls.find(row => row.method === 'memory.accept')?.params).toEqual({ projectPath: PROJECT, id: 'ms-01', fact: 'Compare flaky tests with a master run', details: 'Run it on master first.' });
    expect(screen.queryByLabelText('Fact')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await screen.findByText('Suggested (0)'); expect(onCount).toHaveBeenLastCalledWith(0);
    expect(bridge.calls.at(-1)).toMatchObject({ method: 'memory.dismiss', params: { projectPath: PROJECT, id: 'ms-02' } });
  });
  it('a plain Add sends only the id', async () => {
    bridge.setHandler('memory.get', () => snap({ suggestions: [suggestion] }));
    bridge.setHandler('memory.accept', () => snap({ items: [item()] }));
    render(show()); await screen.findByText('Suggested (1)');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(methods()).toContain('memory.accept'));
    expect(bridge.calls.find(row => row.method === 'memory.accept')?.params).toEqual({ projectPath: PROJECT, id: 'ms-01' });
  });
});

describe('Memory tab: Add entry and Edit', () => {
  it('Add entry sends kind, fact and the snapshot version', async () => {
    bridge.setHandler('memory.get', () => snap({ version: 'v7' }));
    bridge.setHandler('memory.add', () => snap({ version: 'v8', items: [item({ id: 'm-001', kind: 'agreement', author: 'human', by: undefined })] }));
    render(show()); await screen.findByRole('button', { name: 'Add entry' });
    fireEvent.click(screen.getByRole('button', { name: 'Add entry' }));
    expect((screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'agreement' } });
    fireEvent.change(screen.getByLabelText('Fact'), { target: { value: 'Close sessions with consent' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(methods()).toContain('memory.add'));
    expect(bridge.calls.find(row => row.method === 'memory.add')?.params).toEqual({ projectPath: PROJECT, kind: 'agreement', fact: 'Close sessions with consent', version: 'v7' });
  });
  it('opening the form (Add entry, Edit, Edit & add) moves focus to Fact and scrolls the form into view', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    try {
      bridge.setHandler('memory.get', () => snap({ items: [item()], suggestions: [suggestion] }));
      render(show());
      for (const name of ['Add entry', 'Edit: PTY tests flake in long-path worktrees', 'Edit & add']) {
        scroll.mockClear();
        fireEvent.click(await screen.findByRole('button', { name }));
        await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Fact')));
        expect(scroll).toHaveBeenCalledWith({ block: 'nearest' });
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      }
    } finally { Reflect.deleteProperty(Element.prototype, 'scrollIntoView'); }
  });
  it('the comment brackets of the file format cannot be typed into a fact', async () => {
    bridge.setHandler('memory.get', () => snap());
    render(show()); fireEvent.click(await screen.findByRole('button', { name: 'Add entry' }));
    fireEvent.change(screen.getByLabelText('Fact'), { target: { value: 'x <!-- m-009 -->' } });
    expect((screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('Edit sends the entry id, version and the new fact and details', async () => {
    bridge.setHandler('memory.get', () => snap({ version: 'v3', items: [item()] }));
    bridge.setHandler('memory.update', () => snap({ version: 'v4', items: [item({ fact: 'Changed', amended: true })] }));
    render(show()); fireEvent.click(await screen.findByRole('button', { name: 'Edit: PTY tests flake in long-path worktrees' }));
    fireEvent.change(screen.getByLabelText('Fact'), { target: { value: 'Changed' } });
    fireEvent.change(screen.getByLabelText('Details'), { target: { value: 'More' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/Edited by you/);
    expect(bridge.calls.find(row => row.method === 'memory.update')?.params).toEqual({ projectPath: PROJECT, id: 'm-001', version: 'v3', patch: { fact: 'Changed', details: 'More' } });
  });
  it('a conflict keeps the form and says the memory changed', async () => {
    bridge.setHandler('memory.get', () => snap({ items: [item()] }));
    bridge.setHandler('memory.update', () => { throw encodeIpcError({ code: 'conflict', message: 'x' }); });
    render(show()); fireEvent.click(await screen.findByRole('button', { name: 'Edit: PTY tests flake in long-path worktrees' }));
    fireEvent.change(screen.getByLabelText('Fact'), { target: { value: 'Changed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/The memory changed/);
    expect(screen.getByLabelText('Fact')).toBeTruthy();
  });
});

describe('Memory tab: Undo of entries remembered on request', () => {
  const undoable = { operationId: 'remember:ms-04', memoryId: 'm-004', fact: 'Close sessions with consent', workId: 'w-0001', sessionId: 's-01' };
  it('lists the entry with an Undo that sends the operation and refreshes the list', async () => {
    let current = snap({ items: [item({ id: 'm-004', fact: undoable.fact, onRequest: true })], undoable: [undoable] });
    bridge.setHandler('memory.get', () => current);
    bridge.setHandler('memory.undo', () => { current = snap({ version: 'v2' }); return current; });
    render(show());
    await screen.findByText('Remembered on request');
    fireEvent.click(screen.getByRole('button', { name: 'Undo: Close sessions with consent' }));
    await waitFor(() => expect(screen.queryByText('Remembered on request')).toBeNull());
    expect(bridge.calls.find(row => row.method === 'memory.undo')?.params).toEqual({ projectPath: PROJECT, operationId: 'remember:ms-04' });
    expect(screen.queryByText('Close sessions with consent')).toBeNull();
  });
  it('after the human edited the entry Undo says it kept it, and the entry stays', async () => {
    bridge.setHandler('memory.get', () => snap({ items: [item({ id: 'm-004', fact: undoable.fact, onRequest: true })], undoable: [undoable] }));
    bridge.setHandler('memory.undo', () => { throw encodeIpcError({ code: 'conflict', message: 'x' }); });
    render(show());
    fireEvent.click(await screen.findByRole('button', { name: 'Undo: Close sessions with consent' }));
    await screen.findByText(/Undo kept it/);
    expect(screen.getAllByText('Close sessions with consent').length).toBeGreaterThan(0);
  });
});

describe('Memory tab: availability and lifecycle', () => {
  it('an old host shows a message and makes no calls', () => {
    render(show({ supported: false }));
    expect(screen.getByText(/does not support project memory/)).toBeTruthy(); expect(bridge.calls).toEqual([]);
  });
  it('a failed load is visible and sanitised', async () => {
    bridge.setHandler('memory.get', () => { throw new Error('SECRET_PATH /Users/x'); });
    render(show());
    await screen.findByText(/Project memory could not be loaded/); expect(document.body.textContent).not.toContain('SECRET_PATH');
  });
  it('an invalid reply is rejected and a reply for another project is ignored', async () => {
    bridge.setHandler('memory.get', () => ({ ...snap(), projectPath: '/other' }));
    render(show()); await screen.findByText(/Project memory could not be loaded/);
  });
  it('drops an old reply after the connection or the project changed', async () => {
    const old = deferred<MemorySnapshot>(); let first = true;
    bridge.setHandler('memory.get', () => { if (first) { first = false; return old.promise; } return snap({ items: [item({ fact: 'Fresh entry' })] }); });
    const { rerender } = render(show());
    rerender(show({ connection: 2 }));
    await screen.findByText('Fresh entry');
    await act(async () => { old.resolve(snap({ items: [item({ fact: 'Stale entry' })] })); });
    expect(screen.queryByText('Stale entry')).toBeNull();
  });
  it('shows ignore diagnostics from the host', async () => {
    bridge.setHandler('memory.get', () => snap({ diagnostics: [{ code: 'parley-dir-ignored' }] }));
    render(show()); await screen.findByText(/memory stays local/);
  });
});
