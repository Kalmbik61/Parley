import * as fs from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addSession, addMessage } from './map.js';
import { addRoom } from './rooms.js';
import { createWork, readMap, updateMap, sharedProjectPaths } from './store.js';
import { HUMAN, SYSTEM } from './types.js';
import { rebuildRoomHistory, renderRoomHistory, shareRoomHistory, unshareRoomHistory, removeLocalRoomHistories } from './room-history.js';
const receiptAttack = vi.hoisted(() => ({ mode: '', temporary: '', foreignIno: 0 }));
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename), open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args); const file = String(args[0]);
    if (receiptAttack.mode && file.includes('.receipt.json.') && file.endsWith('.tmp')) {
      const mode = receiptAttack.mode; receiptAttack.mode = ''; const close = handle.close.bind(handle);
      handle.close = async () => {
        await close(); const bytes = await actual.readFile(file);
        await actual.rename(file, file + '.owned-aside'); await actual.writeFile(file, bytes);
        receiptAttack.temporary = file; receiptAttack.foreignIno = (await actual.lstat(file)).ino;
        if (mode === 'cleanup') await actual.writeFile(file.slice(0, file.indexOf('.receipt.json.')) + '.receipt.json', 'Human replaced receipt');
      };
    }
    return handle;
  } };
});
let root: string; let project: string; let workId: string; let previous: string | undefined;
beforeEach(async () => {
  receiptAttack.mode = ""; receiptAttack.temporary = ""; receiptAttack.foreignIno = 0;
  vi.mocked(fs.rename).mockImplementation((await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename);
  root = await realpath(await mkdtemp('/private/tmp/parley-room-history-'));
  project = path.join(root, 'project'); await mkdir(project); await mkdir(path.join(root, 'home'));
  previous = process.env.PARLEY_HOME; process.env.PARLEY_HOME = path.join(root, 'home');
  workId = (await createWork(project, { title: 'Work' })).work.id;
  await updateMap(project, workId, map => {
    addSession(map, { provider: 'codex', label: 'Lead', task: 'Bounded', role: { source: 'builtin', name: 'reviewer' } });
    addRoom(map, { title: 'Room', creator: HUMAN, members: ['s-01'], lead: 's-01' });
    addMessage(map, { from: 's-01', to: [], roomId: 'r-01', kind: 'question', text: 'Human-readable feed' });
    addMessage(map, { from: SYSTEM, to: [], roomId: 'r-01', kind: 'note', text: 'Accepted or returned plan event' });
    addMessage(map, { from: 's-01', to: [HUMAN], kind: 'note', text: 'Private solo letter' });
  });
});
afterEach(async () => { if (previous === undefined) delete process.env.PARLEY_HOME; else process.env.PARLEY_HOME = previous; await rm(root, { recursive: true, force: true }); });
const local = () => path.join(project, '.parley', 'history', `${workId}-r-01.md`);
const shared = () => path.join(project, '.parley', 'history-shared', `${workId}-r-01.md`);
const amend = () => updateMap(project, workId, map => { addMessage(map, { from: HUMAN, to: [], roomId: 'r-01', kind: 'note', text: 'Later human text' }); });
describe('derived local history and explicitly owned shared snapshots', () => {
  it('renders room/system feed, roles and mode while excluding direct/provider transcripts', async () => {
    const source = renderRoomHistory(await readMap(project, workId), 'r-01');
    expect(source).toContain('builtin:"reviewer"'); expect(source).toContain('mode: free');
    expect(source).toContain('Human-readable feed'); expect(source).toContain('Accepted or returned'); expect(source).not.toContain('Private solo');
    await rebuildRoomHistory(project, workId, 'r-01'); expect(await readFile(local(), 'utf8')).toBe(source);
    expect(await readdir(path.join(project, '.parley'))).not.toContain('history-shared');
  });
  it('manual Share freezes a snapshot; ordinary rebuild never updates shared text, repeat explicit Share does', async () => {
    const first = await shareRoomHistory(project, workId, 'r-01'); expect(first.sharedAt).not.toBeNull();
    const original = await readFile(shared(), 'utf8'); await amend(); await rebuildRoomHistory(project, workId, 'r-01');
    expect(await readFile(shared(), 'utf8')).toBe(original); expect(await readFile(local(), 'utf8')).toContain('Later human text');
    await shareRoomHistory(project, workId, 'r-01'); expect(await readFile(shared(), 'utf8')).toContain('Later human text');
    await unshareRoomHistory(project, workId, 'r-01'); await expect(readFile(shared())).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await unshareRoomHistory(project, workId, 'r-01')).sharedAt).toBeNull();
  });
  it('preserves a foreign shared file even when its bytes equal the generated history', async () => {
    const paths = await sharedProjectPaths(project); await mkdir(paths.historyShared);
    const content = renderRoomHistory(await readMap(project, workId), 'r-01'); await writeFile(shared(), content);
    await expect(shareRoomHistory(project, workId, 'r-01')).rejects.toMatchObject({ code: 'history-conflict' });
    await expect(unshareRoomHistory(project, workId, 'r-01')).rejects.toMatchObject({ code: 'history-conflict' });
    expect(await readFile(shared(), 'utf8')).toBe(content);
  });
  it('preserves same-content foreign inode replacement, edited shared text and unshare callbacks racing an editor', async () => {
    await shareRoomHistory(project, workId, 'r-01'); const original = await readFile(shared(), 'utf8');
    await rm(shared()); await writeFile(shared(), original); await amend();
    await expect(shareRoomHistory(project, workId, 'r-01')).rejects.toMatchObject({ code: 'history-conflict' });
    await expect(unshareRoomHistory(project, workId, 'r-01')).rejects.toMatchObject({ code: 'history-conflict' });
    expect(await readFile(shared(), 'utf8')).toBe(original);
  });
  it('lost acknowledgement recovers only own linked inode, not a missing-to-identical foreign target', async () => {
    const content = renderRoomHistory(await readMap(project, workId), 'r-01');
    await expect(shareRoomHistory(project, workId, 'r-01', { beforeCommit: async file => { if (file === shared()) { await writeFile(file, content); } } })).rejects.toMatchObject({ code: 'history-conflict' });
    await expect(shareRoomHistory(project, workId, 'r-01')).rejects.toMatchObject({ code: 'history-conflict' });
    expect(await readFile(shared(), 'utf8')).toBe(content);
  });
  it('source changes or work deletion before publication prevent stale local output', async () => {
    await expect(rebuildRoomHistory(project, workId, 'r-01', { beforeCommit: async () => { await amend(); } })).rejects.toMatchObject({ code: 'history-stale' });
    await expect(readFile(local())).rejects.toMatchObject({ code: 'ENOENT' });
    await rebuildRoomHistory(project, workId, 'r-01'); expect(await readFile(local(), 'utf8')).toContain('Later human text');
  });
  it('symlinked parents/leafs and manually edited local history are preserved', async () => {
    const outside = path.join(root, 'foreign'); await mkdir(outside); await writeFile(path.join(outside, 'keep'), 'Foreign');
    await symlink(outside, path.join(project, '.parley', 'history'));
    await expect(rebuildRoomHistory(project, workId, 'r-01')).rejects.toMatchObject({ code: 'history-unavailable' });
    expect(await readFile(path.join(outside, 'keep'), 'utf8')).toBe('Foreign');
    await rm(path.join(project, '.parley', 'history')); await rebuildRoomHistory(project, workId, 'r-01'); await writeFile(local(), 'Edited local');
    await amend(); await expect(rebuildRoomHistory(project, workId, 'r-01')).rejects.toMatchObject({ code: 'history-conflict' });
    expect(await readFile(local(), 'utf8')).toBe('Edited local');
  });
  it('work removal cleans only proven local history/receipt and preserves shared snapshot', async () => {
    await shareRoomHistory(project, workId, 'r-01'); const content = await readFile(shared(), 'utf8');
    expect((await removeLocalRoomHistories(project, workId, ['r-01'])).removed).toBe(1);
    await expect(readFile(local())).rejects.toMatchObject({ code: 'ENOENT' }); expect(await readFile(shared(), 'utf8')).toBe(content);
    expect((await removeLocalRoomHistories(project, workId, ['r-01'])).failed).toEqual([]);
  });
});

it('legacy feed scalar/control units are explicitly represented while valid emoji, BOM and EOL are retained', async () => {
  await updateMap(project, workId, map => { map.messages[0]!.text = '\uFEFFOriginal\r\n😀\nBad \ud800\0\u0001'; });
  const source = renderRoomHistory(await readMap(project, workId), 'r-01');
  expect(source).toContain('generated representation'); expect(source).toContain('\uFEFFOriginal\r\n😀');
  expect(source).toContain('\\ud800'); expect(source).toContain('\\u0000'); expect(source).not.toContain('�');
  await rebuildRoomHistory(project, workId, 'r-01'); expect(await readFile(local(), 'utf8')).toBe(source);
});

it('lost receipt acknowledgement recovers the prepared own inode without republishing or losing the human snapshot', async () => {
  await expect(shareRoomHistory(project, workId, 'r-01', {
    beforeCommit: async target => {
      if (target === shared()) vi.mocked(fs.rename).mockRejectedValueOnce(new Error('Synthetic acknowledgement failure'));
    },
  })).rejects.toMatchObject({ code: 'history-unavailable' });
  const info = await fs.lstat(shared()); const content = await readFile(shared(), 'utf8');
  const result = await shareRoomHistory(project, workId, 'r-01');
  expect(result.sharedAt).not.toBeNull(); expect((await fs.lstat(shared())).ino).toBe(info.ino);
  expect(await readFile(shared(), 'utf8')).toBe(content);
  expect((await fs.stat(local())).mode & 0o777).toBe(0o600);
});

it('Unshare rechecks editor changes after its callback and never deletes an edited shared file', async () => {
  await shareRoomHistory(project, workId, 'r-01');
  await expect(unshareRoomHistory(project, workId, 'r-01', { beforeCommit: async target => { await writeFile(target, 'Human edited during Unshare'); } })).rejects.toMatchObject({ code: 'history-conflict' });
  expect(await readFile(shared(), 'utf8')).toBe('Human edited during Unshare');
});

it('local-only history builds and deletes without discovering an unknown native main context', async () => {
  const readGit = vi.fn(async () => { throw new Error('unknown native context'); });
  await rebuildRoomHistory(project, workId, 'r-01', { readGit });
  expect(await readFile(local(), 'utf8')).toContain('Human-readable feed');
  expect(readGit).not.toHaveBeenCalled();
  await amend(); await rebuildRoomHistory(project, workId, 'r-01', { readGit });
  expect(await readFile(local(), 'utf8')).toContain('Later human text');
  expect((await removeLocalRoomHistories(project, workId, ['r-01'], { readGit })).failed).toEqual([]);
  expect(readGit).not.toHaveBeenCalled();
});

it('prior shared proof fails closed when canonical native context is now unknown', async () => {
  await shareRoomHistory(project, workId, 'r-01');
  const before = await readFile(local(), 'utf8'); const published = await readFile(shared(), 'utf8');
  const readGit = async (): Promise<never> => { throw new Error('unknown'); };
  await amend();
  await expect(rebuildRoomHistory(project, workId, 'r-01', { readGit })).rejects.toMatchObject({ code: 'history-unavailable' });
  expect((await removeLocalRoomHistories(project, workId, ['r-01'], { readGit })).failed).toEqual([{ roomId: 'r-01', code: 'history-unavailable' }]);
  expect(await readFile(local(), 'utf8')).toBe(before); expect(await readFile(shared(), 'utf8')).toBe(published);
});

it('local receipt serialization blocks a competing Share with bounded timeout and releases after publication', async () => {
  let release!: () => void; let entered!: () => void;
  const prepared = new Promise<void>(resolve => { entered = resolve; });
  const block = new Promise<void>(resolve => { release = resolve; });
  const localWrite = rebuildRoomHistory(project, workId, 'r-01', { beforeCommit: async () => { entered(); await block; } });
  await prepared;
  await expect(shareRoomHistory(project, workId, 'r-01', { lockTimeoutMs: 1 })).rejects.toMatchObject({ code: 'history-unavailable' });
  release(); await localWrite;
  await shareRoomHistory(project, workId, 'r-01');
  await expect(readFile(path.join(project, '.parley', 'history', 'history.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('a foreign local lock symlink is preserved and never followed', async () => {
  await rebuildRoomHistory(project, workId, 'r-01');
  const foreign = path.join(root, 'foreign-lock'); await writeFile(foreign, 'Keep');
  const lock = path.join(project, '.parley', 'history', 'history.lock'); await symlink(foreign, lock);
  await expect(rebuildRoomHistory(project, workId, 'r-01', { lockTimeoutMs: 1 })).rejects.toMatchObject({ code: 'history-unavailable' });
  expect(await readFile(foreign, 'utf8')).toBe('Keep'); expect((await fs.lstat(lock)).isSymbolicLink()).toBe(true);
});


it('refuses an identical foreign receipt temp inode swapped after own descriptor close', async () => {
  receiptAttack.mode = 'publish';
  await expect(shareRoomHistory(project, workId, 'r-01')).rejects.toMatchObject({ code: 'history-unavailable' });
  expect((await fs.lstat(receiptAttack.temporary)).ino).toBe(receiptAttack.foreignIno);
  await expect(readFile(shared())).rejects.toMatchObject({ code: 'ENOENT' });
});

it('refused receipt publication preserves foreign temp and concurrent human receipt text', async () => {
  receiptAttack.mode = 'cleanup';
  await expect(shareRoomHistory(project, workId, 'r-01')).rejects.toMatchObject({ code: 'history-unavailable' });
  expect((await fs.lstat(receiptAttack.temporary)).ino).toBe(receiptAttack.foreignIno);
  const receipt = path.join(project, '.parley', 'history', `${workId}-r-01.receipt.json`);
  expect(await readFile(receipt, 'utf8')).toBe('Human replaced receipt');
  await expect(readFile(shared())).rejects.toMatchObject({ code: 'ENOENT' });
});
