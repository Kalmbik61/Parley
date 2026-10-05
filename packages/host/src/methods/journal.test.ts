import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HUMAN, addRoom, addSession, createWork, flushDecisionJournal, readMap, resolveProposal, setProposal, updateMap } from '@parley/core';
import type { WorkEntry } from '@parley/core';
import type { WorksService } from '../works/works-service.js';
import { createJournalHandlers } from './journal.js';

const run = promisify(execFile);
let root: string; let project: string; let previous: string | undefined; let entries: WorkEntry[];
const works = { snapshot: () => ({ entries, branches: {} }) } as unknown as WorksService;
const handlers = () => createJournalHandlers(works);
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'parley-journal-host-')));
  project = path.join(root, 'project'); await mkdir(project); await mkdir(path.join(root, 'home'));
  previous = process.env['PARLEY_HOME']; process.env['PARLEY_HOME'] = path.join(root, 'home');
  entries = [];
});
afterEach(async () => {
  if (previous === undefined) delete process.env['PARLEY_HOME']; else process.env['PARLEY_HOME'] = previous;
  await rm(root, { recursive: true, force: true });
});
const decisions = (at: string) => path.join(at, '.parley', 'decisions');
async function refresh(at: string, workId: string): Promise<void> {
  entries = [...entries.filter(row => !(row.projectPath === at && row.map.work.id === workId)), { projectPath: at, map: await readMap(at, workId) } as WorkEntry];
}
/** Работа с комнатой и принятыми решениями: `texts` — по одному принятому решению на текст. */
async function accepted(at: string, texts: string[], flush = true): Promise<string> {
  const workId = (await createWork(at, { title: 'Journal' })).work.id;
  await updateMap(at, workId, map => {
    addSession(map, { provider: 'codex', label: 'Lead', task: 'Bounded' });
    addRoom(map, { title: 'Room', creator: HUMAN, members: ['s-01'], lead: 's-01' });
    for (const text of texts) {
      const proposal = setProposal(map, 'r-01', 's-01', text, new Date().toISOString());
      resolveProposal(map, 'r-01', proposal.proposalId, 'accept', { rev: proposal.rev });
    }
  });
  if (flush) await flushDecisionJournal(at, workId);
  await refresh(at, workId);
  return workId;
}
const tree = async (dir: string): Promise<string[]> => (await readdir(dir, { recursive: true }).catch(() => [])).sort();

describe('decisions.list', () => {
  it('lists accepted decisions newest first with a filter and a limit, and creates nothing', async () => {
    const workId = await accepted(project, ['Use sqlite\nbecause small', 'Ship the beta']);
    const before = await tree(path.join(project, '.parley'));
    const all = await handlers()['decisions.list']({ projectPath: project });
    expect(all).toMatchObject({ total: 2, partial: false, errors: [] });
    expect(all.decisions.map(row => row.state)).toEqual(['accepted', 'accepted']);
    expect(all.decisions.every(row => row.openable && row.workId === workId && /^2\d{3}-\d\d-\d\d-w-\d+-r-01-p-0\d-rev-00\.md$/.test(row.file))).toBe(true);
    expect(all.decisions.map(row => row.title).sort()).toEqual(['Ship the beta', 'Use sqlite']);
    const filtered = await handlers()['decisions.list']({ projectPath: project, query: 'SQLITE' });
    expect(filtered.decisions.map(row => row.title)).toEqual(['Use sqlite']);
    expect(filtered.total).toBe(1);
    const limited = await handlers()['decisions.list']({ projectPath: project, limit: 1 });
    expect(limited.decisions).toHaveLength(1); expect(limited.total).toBe(2);
    expect(await tree(path.join(project, '.parley'))).toEqual(before);
  });
  it('keeps decisions of a deleted work visible and openable as retained, with their own revision file', async () => {
    await accepted(project, ['First', 'Second']);
    entries = [];
    const result = await handlers()['decisions.list']({ projectPath: project });
    expect(result.decisions.map(row => [row.state, row.openable])).toEqual([['retained', true], ['retained', true]]);
    expect(new Set(result.decisions.map(row => row.file)).size).toBe(2);
  });
  it('does not present an edited or foreign file as an accepted decision', async () => {
    const workId = await accepted(project, ['Original']);
    const [row] = (await handlers()['decisions.list']({ projectPath: project })).decisions;
    await writeFile(path.join(decisions(project), row!.file), 'Human rewrote it');
    await writeFile(path.join(decisions(project), '2026-01-01-w-0099-r-01-p-01-rev-00.md'), 'Not a journal header');
    const result = await handlers()['decisions.list']({ projectPath: project });
    expect(result.decisions.find(item => item.workId === workId)).toMatchObject({ state: 'edited', openable: false });
    expect(result.decisions.find(item => item.workId === 'w-0099')).toMatchObject({ state: 'unverified', openable: false });
  });
  it('shows a captured decision that has not been written as pending and not openable', async () => {
    await accepted(project, ['Waiting for disk'], false);
    const result = await handlers()['decisions.list']({ projectPath: project });
    expect(result.decisions).toMatchObject([{ state: 'pending', openable: false, title: 'Waiting for disk' }]);
    expect(await tree(path.join(project, '.parley'))).not.toContain('decisions');
  });
  it('reports unreadable and unrecognized files without reading symlink targets', async () => {
    await accepted(project, ['Readable']);
    const outside = path.join(root, 'outside.md'); await writeFile(outside, 'Outside secret');
    await symlink(outside, path.join(decisions(project), '2026-10-05-w-0009-r-01-p-01-rev-00.md'));
    await writeFile(path.join(decisions(project), 'notes.md'), 'Human notes');
    const result = await handlers()['decisions.list']({ projectPath: project });
    expect(result.decisions).toHaveLength(1);
    expect(result.partial).toBe(true);
    expect(result.errors).toEqual([{ code: 'file-unreadable', count: 1 }, { code: 'file-unrecognized', count: 1 }]);
    expect(JSON.stringify(result)).not.toContain('Outside secret');
  });
  it('a symlinked decisions folder is a fixed safe error, never a read through the link', async () => {
    await accepted(project, ['Readable']);
    await rm(decisions(project), { recursive: true }); await symlink(root, decisions(project));
    await expect(handlers()['decisions.list']({ projectPath: project })).rejects.toMatchObject({ code: 'internal', data: { code: 'journal-unavailable' } });
  });
  it('rejects relative paths and unknown fields, and an empty journal is empty', async () => {
    await expect(handlers()['decisions.list']({ projectPath: 'relative' })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(handlers()['decisions.list']({ projectPath: project, extra: 1 } as never)).rejects.toMatchObject({ code: 'bad_request' });
    expect(await handlers()['decisions.list']({ projectPath: project })).toEqual({ decisions: [], total: 0, partial: false, errors: [] });
  });
  it('decisions of a work in a linked worktree are verified against its map in the shared main folder', async () => {
    const main = path.join(root, 'main'); const participant = path.join(root, 'participant'); await mkdir(main);
    await run('git', ['init', '-b', 'main', main]);
    await run('git', ['-C', main, 'config', 'user.name', 'Fixture']); await run('git', ['-C', main, 'config', 'user.email', 'fixture@example.invalid']);
    await writeFile(path.join(main, 'README.md'), 'Fixture'); await run('git', ['-C', main, 'add', 'README.md']); await run('git', ['-C', main, 'commit', '-m', 'fixture']);
    await run('git', ['-C', main, 'worktree', 'add', '-b', 'participant', participant]);
    await accepted(participant, ['From the worktree']);
    const result = await handlers()['decisions.list']({ projectPath: main });
    expect(result.decisions).toMatchObject([{ state: 'accepted', openable: true, title: 'From the worktree' }]);
    expect(await tree(decisions(main))).toHaveLength(1);
  });
});

describe('room history methods', () => {
  let workId: string;
  const room = () => ({ projectPath: project, workId, roomId: 'r-01' });
  const sharedFile = () => path.join(project, '.parley', 'history-shared', `${workId}-r-01.md`);
  beforeEach(async () => { workId = await accepted(project, ['Hello']); });
  it('get is read-only and reports state from the receipt, never from the window', async () => {
    const before = await tree(path.join(project, '.parley'));
    expect(await handlers()['rooms.history.get'](room())).toEqual({ state: 'not-shared', sharedAt: null, version: 'missing', diagnostics: [] });
    expect(await tree(path.join(project, '.parley'))).toEqual(before);
    await expect(handlers()['rooms.history.get']({ ...room(), roomId: 'r-99' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(handlers()['rooms.history.get']({ ...room(), workId: 'w-9999' })).rejects.toBeInstanceOf(Error);
    await expect(handlers()['rooms.history.get']({ ...room(), projectPath: '../x' })).rejects.toMatchObject({ code: 'bad_request' });
  });
  it('Share without explicit confirmation publishes nothing', async () => {
    const before = await tree(path.join(project, '.parley'));
    for (const params of [{ ...room(), expectedVersion: 'missing' }, { ...room(), expectedVersion: 'missing', confirmed: false }])
      await expect(handlers()['rooms.history.share'](params as never)).rejects.toMatchObject({ code: 'bad_request' });
    expect(await tree(path.join(project, '.parley'))).toEqual(before);
    await expect(readFile(sharedFile())).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('confirmed Share publishes the snapshot and reports sharedAt; Unshare removes it', async () => {
    const shared = await handlers()['rooms.history.share']({ ...room(), expectedVersion: 'missing', confirmed: true });
    expect(shared).toMatchObject({ state: 'shared', diagnostics: [] }); expect(shared.sharedAt).not.toBeNull();
    expect(await readFile(sharedFile(), 'utf8')).toContain('# Room');
    expect(await handlers()['rooms.history.get'](room())).toEqual(shared);
    const gone = await handlers()['rooms.history.unshare']({ ...room(), expectedVersion: shared.version });
    expect(gone).toEqual({ state: 'not-shared', sharedAt: null, version: 'missing', diagnostics: [] });
    await expect(readFile(sharedFile())).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('a stale version is a conflict that changes nothing; the window cannot override ownership', async () => {
    const shared = await handlers()['rooms.history.share']({ ...room(), expectedVersion: 'missing', confirmed: true });
    const text = await readFile(sharedFile(), 'utf8');
    await expect(handlers()['rooms.history.share']({ ...room(), expectedVersion: 'missing', confirmed: true })).rejects.toMatchObject({ code: 'conflict' });
    await expect(handlers()['rooms.history.unshare']({ ...room(), expectedVersion: 'old' })).rejects.toMatchObject({ code: 'conflict' });
    await writeFile(sharedFile(), 'Human edit');
    const edited = await handlers()['rooms.history.get'](room());
    expect(edited).toMatchObject({ state: 'conflict', sharedAt: null });
    expect(edited.version).not.toBe(shared.version);
    await expect(handlers()['rooms.history.unshare']({ ...room(), expectedVersion: edited.version })).rejects.toMatchObject({ code: 'conflict' });
    await expect(handlers()['rooms.history.share']({ ...room(), expectedVersion: edited.version, confirmed: true })).rejects.toMatchObject({ code: 'conflict' });
    expect(await readFile(sharedFile(), 'utf8')).toBe('Human edit'); expect(text).not.toBe('Human edit');
  });
  it('a failed export is a safe error and leaves no false sharedAt', async () => {
    const outside = path.join(root, 'foreign-shared'); await mkdir(outside); await symlink(outside, path.join(project, '.parley', 'history-shared'));
    const error = await handlers()['rooms.history.share']({ ...room(), expectedVersion: 'missing', confirmed: true }).catch((value: unknown) => value) as { code: string; message: string };
    expect(error).toMatchObject({ code: 'internal', data: { code: 'history-unavailable' } }); expect(String(error.message)).not.toContain(outside);
    expect(await readdir(outside)).toEqual([]);
    expect(await handlers()['rooms.history.get'](room())).toMatchObject({ state: 'not-shared', sharedAt: null });
  });
});
