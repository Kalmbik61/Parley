import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addRoom, addSession, createWork, deleteWorkFiles, captureWorks, gitBranch, readWorks, onMapWritten, workIdentity, watchWorks, mailWorkMap, projectWindowMail, storeLetterReader, updateMap, workVersion, writeLetters } from '@parley/core';
import { COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE, WORKS_SYNC_FEATURE, WorksMailStateAssembler, WorksSyncReducer } from '@parley/protocol';
import type { RoomsMailEvent, WorksMailStatePage, WorksSyncPage } from '@parley/protocol';
import type { Client } from '../client.js';
import type { HostContext } from '../context.js';
import { createWorksService } from './works-service.js';
import type { WorksService } from './works-service.js';

const { DatabaseSync: Database } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

vi.mock('@parley/core', async original => {
  const actual = await original<typeof import('@parley/core')>();
  return { ...actual, captureWorks: vi.fn(actual.captureWorks), gitBranch: vi.fn(actual.gitBranch), watchWorks: vi.fn(actual.watchWorks), projectWindowMail: vi.fn(actual.projectWindowMail) };
});
let home = '', project = '';
const services: WorksService[] = [];
const clients: Array<Client & { sent: Array<{ event?: string; data?: unknown }> }> = [];
function client(id: string, features: string[], role?: 'remote') {
  const c = { id, name: id, features: new Set(features), ...(role === undefined ? {} : { role }), sent: [] as Array<{ event?: string; data?: unknown }>, send(data: unknown) { this.sent.push(data as never); return true; }, writableLength: () => 0, close() {} };
  clients.push(c); return c;
}
function host(): HostContext {
  return { version: 'fixture', startedAt: 'x', paths: { dir: '', socket: '', token: '', pid: '', log: '' }, log: { info() {}, warn() {}, error() {} }, clients: () => clients, liveSessions: () => 0,
    broadcast(event, data, only) { for (const c of clients) if (only === undefined || only(c)) c.send({ event, data }); }, onShutdown() {}, shutdown: async () => {}, busy() {}, hold() {} };
}
async function service(enabled = true, pageBytes?: number, debounceMs = 5) {
  const s = createWorksService(host(), { debounceMs, mailBatchMs: 5, ...(enabled ? { sync: { enabled: true as const, ...(pageBytes === undefined ? {} : { pageBytes }) } } : {}) });
  services.push(s); await s.start(); return s;
}
async function seed(count = 2, text = 20) {
  const map = await createWork(project, { title: 'fixture', goal: 'goal' });
  await updateMap(project, map.work.id, current => {
    for (let i = 0; i < count; i += 1) addSession(current, { provider: 'codex', label: 'fixture', task: 'x'.repeat(text) });
    addRoom(current, { title: 'mail', creator: 'human', members: current.sessions.slice(0, 2).map(s => s.id), lead: current.sessions[0]!.id });
  });
  return map.work.id;
}
async function pull(s: WorksService, c: Client, base = 0, reducer = new WorksSyncReducer()) {
  let request: { base: number } | { cursor: string } = { base };
  for (;;) {
    const reply = await s.sync!.pull(c, request, 1);
    const page = reply.result as WorksSyncPage;
    expect(page.kind).toBe('page');
    expect(reducer.applyPage(page).state).not.toBe('rejected');
    if (page.commit) return reducer;
    request = { cursor: page.next! };
  }
}
async function mail(s: WorksService, c: Client, workId: string, first?: WorksMailStatePage) {
  const key = { projectPath: project, workId }, assembler = new WorksMailStateAssembler({ epoch: s.sync!.epoch, key });
  let page = first ?? (await s.sync!.pullMailState(c, key, 1)).result as WorksMailStatePage;
  for (;;) {
    expect(page.kind).toBe('mail-page');
    expect(assembler.applyPage(page).state).not.toBe('rejected');
    if (page.commit) return assembler.value!;
    page = (await s.sync!.pullMailState(c, { ...key, cursor: page.next! }, 2)).result as WorksMailStatePage;
  }
}
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'sync-home-')); project = await mkdtemp(path.join(tmpdir(), 'sync-project-'));
  process.env.PARLEY_HOME = home; clients.length = 0; vi.mocked(projectWindowMail).mockClear();
});
afterEach(async () => {
  for (const s of services.splice(0)) await s.stop();
  delete process.env.PARLEY_HOME;
  await Promise.all([home, project].map(dir => rm(dir, { recursive: true, force: true })));
});

describe('opt-in works sync service', () => {
  it('bootstraps and edits a real 3k-session database above5MiB without global snapshots', async () => {
    const id = await seed(3000, 2000);
    const c = client('sync', [WORKS_SYNC_FEATURE, ROOMS_MAIL_FEATURE, COMPACT_WORKS_FEATURE]);
    let globalEncodes = 0;
    const original = JSON.stringify;
    const spy = vi.spyOn(JSON, 'stringify').mockImplementation(((value: unknown, ...args: unknown[]) => {
      if (typeof value === 'object' && value !== null && (Array.isArray((value as { entries?: unknown }).entries) || (value as { event?: string }).event === 'works.changed')) globalEncodes += 1;
      return (original as (...args: unknown[]) => string)(value, ...args);
    }) as typeof JSON.stringify);
    let s: WorksService, reducer: WorksSyncReducer;
    try { s = await service(); reducer = await pull(s, c); } finally { spy.mockRestore(); }
    expect(globalEncodes).toBe(0);
    expect(c.sent.some(m => m.event === 'works.changed')).toBe(false);
    const entry = s!.entry(project, id)!;
    expect(reducer!.view.snapshot.entries[0]!.map).toEqual(mailWorkMap(entry.map, storeLetterReader(project, id)));
    expect(Buffer.byteLength(JSON.stringify(reducer!.view.snapshot))).toBeGreaterThan(5 * 1024 * 1024);
    // Прежний ограниченный mailSnapshot всё ещё отказывает на тех же данных (включая fallback).
    expect(s!.mailSnapshot()).toBeNull();
    const previous = s!.sync!.currentRevision;
    await updateMap(project, id, map => { map.sessions[0]!.task = 'edited'; addSession(map, { provider: 'codex', label: 'new', task: 'new' }); map.sessions.splice(1, 1); });
    await vi.waitFor(() => expect(s!.sync!.currentRevision).toBeGreaterThan(previous), { timeout: 10000, interval: 10 });
    const updated = await pull(s!, c, previous, reducer!);
    expect(updated.view.snapshot.entries[0]!.map.sessions[0]!.task).toBe('edited');
    expect(updated.view.snapshot.entries[0]!.map.sessions.at(-1)!.label).toBe('new');
  }, 30000);

  it('mail-only sends zero sync traffic/projections and persists required structural source watermark', async () => {
    const id = await seed();
    const modern = client('sync', [WORKS_SYNC_FEATURE, ROOMS_MAIL_FEATURE, COMPACT_WORKS_FEATURE]);
    const legacy = client('legacy-mail', [ROOMS_MAIL_FEATURE, COMPACT_WORKS_FEATURE]);
    const remote = client('remote', [ROOMS_MAIL_FEATURE, COMPACT_WORKS_FEATURE, WORKS_SYNC_FEATURE], 'remote');
    const s = await service(); await pull(s, modern);
    const initial = s.sync!.currentRevision;
    const version = s.sync!.snapshot({ projectPath: project, workId: id })!.structuralSourceVersion!;
    vi.mocked(projectWindowMail).mockClear(); for (const c of clients) c.sent.length = 0;
    writeLetters(project, id, letters => letters.add({ kind: 'note', from: 's-01', to: [], roomId: 'r-01', text: 'first' }));
    await vi.waitFor(() => expect(modern.sent.some(m => m.event === 'rooms.mail')).toBe(true));
    expect(projectWindowMail).not.toHaveBeenCalled();
    expect(s.sync!.currentRevision).toBe(initial);
    expect(modern.sent.some(m => m.event === 'works.invalidated' || m.event === 'works.changed')).toBe(false);
    const mail = modern.sent.find(m => m.event === 'rooms.mail')!.data as RoomsMailEvent;
    expect(mail.requiredStructuralVersion).toBe(version);
    expect((legacy.sent.find(m => m.event === 'rooms.mail')!.data as RoomsMailEvent).requiredStructuralVersion).toBeUndefined();
    expect((remote.sent.find(m => m.event === 'rooms.mail')!.data as RoomsMailEvent).requiredStructuralVersion).toBeUndefined();
    expect(s.sync!.snapshot({ projectPath: project, workId: id })!.sourceVersion).toBe(workVersion(project, id));
    await updateMap(project, id, (map, letters) => { map.sessions[0]!.task = 'structure'; letters.add({ kind: 'note', from: 's-01', to: [], roomId: 'r-01', text: 'mixed' }); });
    await vi.waitFor(() => expect(s.sync!.currentRevision).toBeGreaterThan(initial));
    const structural = workVersion(project, id);
    await vi.waitFor(() => expect(modern.sent.some(m => m.event === 'rooms.mail' && (m.data as RoomsMailEvent).requiredStructuralVersion === structural)).toBe(true));
    modern.sent.length = 0;
    writeLetters(project, id, letters => letters.add({ kind: 'note', from: 's-01', to: [], roomId: 'r-01', text: 'after release' }));
    await vi.waitFor(() => expect(modern.sent.some(m => m.event === 'rooms.mail')).toBe(true));
    expect((modern.sent.find(m => m.event === 'rooms.mail')!.data as RoomsMailEvent).requiredStructuralVersion).toBe(structural);
  });

  it('does not confuse later mail progress with pending structural coverage', async () => {
    const id = await seed(); const c = client('sync', [WORKS_SYNC_FEATURE, ROOMS_MAIL_FEATURE]);
    const s = await service(); await pull(s, c);
    const initial = s.sync!.currentRevision;
    await updateMap(project, id, map => { map.sessions[0]!.task = 'must arrive'; });
    writeLetters(project, id, letters => letters.add({ kind: 'note', from: 's-01', to: [], roomId: 'r-01', text: 'newer mail' }));
    await vi.waitFor(() => expect(s.sync!.currentRevision).toBeGreaterThan(initial), { timeout: 3000 });
    expect((await pull(s, c)).view.snapshot.entries[0]!.map.sessions[0]!.task).toBe('must arrive');
  });

  it('keeps default capability off and leaves ordinary legacy snapshots available', async () => {
    await seed(); client('legacy', [ROOMS_MAIL_FEATURE]);
    const s = await service(false);
    expect(s.sync).toBeUndefined();
    expect(s.mailSnapshot()?.entries).toHaveLength(1);
  });

  it('repairs a fresh cached reset after mail-only writes and replaces unread/candidates after decreases', async () => {
    const id = await seed(), c = client('sync', [WORKS_SYNC_FEATURE, ROOMS_MAIL_FEATURE]);
    const s = await service(); await pull(s, c);
    const revision = s.sync!.currentRevision;
    vi.mocked(projectWindowMail).mockClear(); c.sent.length = 0;
    const message = writeLetters(project, id, letters => letters.add({ kind: 'note', from: 's-01', to: ['human'], roomId: null, text: '@human repair' }));
    const fresh = client('fresh', [WORKS_SYNC_FEATURE, ROOMS_MAIL_FEATURE]);
    const reset = await pull(s, fresh);
    expect((reset.view.snapshot.entries[0]!.map.compact as { unread: { letters: number } }).unread.letters).toBe(0);
    const state = await mail(s, fresh, id);
    expect(state.mail.unread).toEqual({ letters: 1, rooms: { '': 1 } });
    expect(state.mail.mentionCandidates.map(m => m.id)).toEqual([message.id]);
    expect(state.requiredStructuralVersion).toBeLessThan(state.sourceVersion);
    writeLetters(project, id, letters => letters.markRead('human', [message.id], 'now'));
    const cleared = await mail(s, fresh, id);
    expect(cleared.mail.unread.letters).toBe(0);
    expect(cleared.mail.mentionCandidates).toEqual([]);
    expect(s.sync!.currentRevision).toBe(revision);
    expect(projectWindowMail).not.toHaveBeenCalled();
    expect(c.sent.some(m => m.event === 'works.invalidated')).toBe(false);
    await deleteWorkFiles(project, id);
    expect((await s.sync!.pullMailState(fresh, { projectPath: project, workId: id }, 3)).result).toEqual({ kind: 'mail-unavailable', reason: 'not-found' });
  });

  it('captures all mail metadata before yielding pages while later writes keep a separate version', async () => {
    const id = await seed();
    await updateMap(project, id, map => { for (let i = 0; i < 100; i += 1) addRoom(map, { title: 'room', creator: 'human', members: [map.sessions[0]!.id], lead: map.sessions[0]!.id }); });
    const c = client('sync', [WORKS_SYNC_FEATURE, ROOMS_MAIL_FEATURE]), s = await service(true, 2048);
    const key = { projectPath: project, workId: id };
    const first = (await s.sync!.pullMailState(c, key, 1)).result as WorksMailStatePage;
    expect(first.commit).toBe(false);
    writeLetters(project, id, letters => letters.add({ kind: 'note', from: 's-01', to: ['human'], roomId: null, text: '@human later' }));
    const pinned = await mail(s, c, id, first);
    expect(pinned.sourceVersion).toBe(first.sourceVersion);
    expect(pinned.mail.unread.letters).toBe(0);
    const latest = await mail(s, c, id);
    expect(latest.sourceVersion).toBeGreaterThan(pinned.sourceVersion);
    expect(latest.mail.unread.letters).toBe(1);
  });

  it('refreshes one coherently captured foreign structure before returning a reachable dependency', async () => {
    const id = await seed(), c = client('sync', [WORKS_SYNC_FEATURE, ROOMS_MAIL_FEATURE]), s = await service();
    const key = { projectPath: project, workId: id };
    vi.mocked(projectWindowMail).mockClear();
    const db = new Database(path.join(home, 'parley.db'));
    try {
      const row = db.prepare('SELECT work_json FROM works WHERE project_path = ? AND id = ?').get(project, id) as { work_json: string };
      const work = JSON.parse(row.work_json) as { goal: string }; work.goal = 'foreign coherent goal';
      db.prepare('UPDATE works SET work_json = ?, version = version + 1 WHERE project_path = ? AND id = ?').run(JSON.stringify(work), project, id);
    } finally { db.close(); }
    const first = await s.sync!.pullMailState(c, key, 1);
    expect(first.result).toEqual({ kind: 'mail-unavailable', reason: 'retry' });
    expect(projectWindowMail).toHaveBeenCalledTimes(1);
    const replacement = await mail(s, c, id);
    expect(replacement.requiredStructuralVersion).toBe(replacement.sourceVersion);
    expect(s.sync!.snapshot(key)!.structuralSourceVersion).toBe(replacement.requiredStructuralVersion);
    expect(s.sync!.snapshot(key)!.map.work.goal).toBe('foreign coherent goal');
  });
});


describe('bounded sync progress and coherent publication', () => {
  it('does not restart the service deadline on back-to-back watcher results', async () => {
    await seed();
    let deliver!: Parameters<typeof watchWorks>[0];
    const close = vi.fn();
    vi.mocked(watchWorks).mockImplementationOnce(callback => { deliver = callback; return { close }; });
    const s = await service(true, undefined, 100);
    const entries = (await readWorks()).map(entry => { const bare = { ...entry }; delete bare.version; return bare; }), captures = vi.mocked(captureWorks).mock.calls.length;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      deliver(entries, 100);
      await vi.advanceTimersByTimeAsync(50); deliver(entries, 101);
      await vi.advanceTimersByTimeAsync(49); expect(captureWorks).toHaveBeenCalledTimes(captures);
      deliver(entries, 102); await vi.advanceTimersByTimeAsync(1);
      expect(captureWorks).toHaveBeenCalledTimes(captures + 1);
      await s.stop(); expect(close).toHaveBeenCalledOnce();
      deliver(entries, 103); await vi.advanceTimersByTimeAsync(1000);
      expect(captureWorks).toHaveBeenCalledTimes(captures + 1);
    } finally { vi.useRealTimers(); }
  });

  it('publishes coherent intermediate V while maintenance waits and ordinary writes reach V+1', async () => {
    const id = await seed(), other = await seed(), s = await service();
    const key = { projectPath: project, workId: id };
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    vi.mocked(gitBranch).mockImplementationOnce(async () => { entered(); await gate; return null; });
    await updateMap(project, id, map => { map.work.goal = 'coherent V'; });
    const version = workVersion(project, id)!;
    await started;
    await updateMap(project, id, map => { map.work.goal = 'later V+1'; });
    await updateMap(project, other, map => { map.work.goal = 'other latest'; });
    const seen: Array<{ goal: string; version: number | undefined }> = [];
    const publish = s.sync!.publish.bind(s.sync!);
    const spy = vi.spyOn(s.sync!, 'publish').mockImplementation(async (...args) => {
      await publish(...args); const snapshot = s.sync!.snapshot(key)!;
      seen.push({ goal: snapshot.map.work.goal, version: snapshot.structuralSourceVersion });
    });
    release();
    await vi.waitFor(() => expect(seen).toContainEqual({ goal: 'coherent V', version }));
    await vi.waitFor(() => expect(s.sync!.snapshot(key)!.map.work.goal).toBe('later V+1'));
    expect(s.sync!.snapshot({ projectPath: project, workId: other })!.map.work.goal).toBe('other latest');
    spy.mockRestore();
  });

  it.each([25, 75, 100])('keeps two works progressing during %ims writes, with one in-flight publication', async interval => {
    const id = await seed(), other = await seed(), s = await service(true, undefined, 100);
    const publish = s.sync!.publish.bind(s.sync!);
    let active = 0, maximum = 0;
    const commits: Array<{ at: number; hot: string; cold: string }> = [];
    const spy = vi.spyOn(s.sync!, 'publish').mockImplementation(async (...args) => {
      active += 1; maximum = Math.max(maximum, active);
      try {
        await publish(...args);
        commits.push({ at: Date.now(), hot: s.sync!.snapshot({ projectPath: project, workId: id })!.map.work.goal,
          cold: s.sync!.snapshot({ projectPath: project, workId: other })!.map.work.goal });
      } finally { active -= 1; }
    });
    const until = Date.now() + 850;
    let n = 0;
    while (Date.now() < until) {
      await updateMap(project, id, map => { map.work.goal = `hot${n}`; });
      if (n % 3 === 0) await updateMap(project, other, map => { map.work.goal = `cold${n}`; });
      n += 1; await new Promise(resolve => setTimeout(resolve, interval));
    }
    const end = Date.now(), expected = await readWorks();
    await vi.waitFor(() => {
      for (const work of expected) expect(s.sync!.snapshot({ projectPath: project, workId: work.map.work.id })!.map.work.goal).toBe(work.map.work.goal);
    });
    const during = commits.filter(commit => commit.at < end);
    expect(during.length).toBeGreaterThanOrEqual(2);
    expect(new Set(during.map(commit => commit.hot)).size).toBeGreaterThanOrEqual(2);
    expect(new Set(during.map(commit => commit.cold)).size).toBeGreaterThanOrEqual(2);
    expect(maximum).toBe(1); spy.mockRestore();
  });

  it.each(['catalogue-add', 'delete-recreate'] as const)('discards %s during row staging, then reacquires without stale pruning/resurrection', async action => {
    const other = await seed(), id = await seed(), s = await service();
    const key = { projectPath: project, workId: id }, prior = s.sync!.snapshot(key)!, revision = s.sync!.currentRevision;
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const fork = s.sync!.rows.fork.bind(s.sync!.rows);
    vi.spyOn(s.sync!.rows, 'fork').mockImplementationOnce(async () => {
      const candidate = await fork(), update = candidate.update.bind(candidate);
      vi.spyOn(candidate, 'update').mockImplementationOnce(async (...args) => { await update(...args); entered(); await gate; });
      return candidate;
    });
    const outcomes: Array<{ rejected: boolean; revision: number; goal: string }> = [];
    const publish = s.sync!.publish.bind(s.sync!);
    const publication = vi.spyOn(s.sync!, 'publish').mockImplementation(async (...args) => {
      try { await publish(...args); }
      catch (error) { outcomes.push({ rejected: true, revision: s.sync!.currentRevision, goal: s.sync!.snapshot(key)!.map.work.goal }); throw error; }
    });
    await updateMap(project, id, map => { map.work.goal = 'must be discarded'; });
    await started;
    expect(s.sync!.snapshot(key)!.map).toEqual(prior.map);
    let added: string | undefined;
    if (action === 'catalogue-add') added = (await createWork(project, { title: 'added during staging' })).work.id;
    else {
      await deleteWorkFiles(project, id);
      const replacement = await createWork(project, { title: 'replacement', goal: 'recreated' });
      expect(replacement.work.id).toBe(id);
    }
    release();
    await vi.waitFor(() => {
      const snapshot = s.sync!.snapshot(key)!;
      expect(snapshot.map.work.goal).toBe(action === 'catalogue-add' ? 'must be discarded' : 'recreated');
      if (added !== undefined) expect(s.sync!.snapshot({ projectPath: project, workId: added })).toBeDefined();
      expect(s.sync!.snapshot({ projectPath: project, workId: other })).toBeDefined();
    });
    expect(outcomes[0]).toEqual({ rejected: true, revision, goal: prior.map.work.goal });
    publication.mockRestore();
  });
});


it('rejects old mail pins after a foreign lifecycle change without waiting for watcher reconciliation', async () => {
  const id = await seed();
  await updateMap(project, id, map => { for (let i = 0; i < 100; i += 1) addRoom(map, { title: 'room', creator: 'human', members: [map.sessions[0]!.id], lead: map.sessions[0]!.id }); });
  const c = client('sync', [WORKS_SYNC_FEATURE, ROOMS_MAIL_FEATURE]), s = await service(true, 2048);
  const key = { projectPath: project, workId: id };
  const first = (await s.sync!.pullMailState(c, key, 1)).result as WorksMailStatePage;
  expect(first.commit).toBe(false);
  const db = new Database(path.join(home, 'parley.db'));
  try {
    const row = db.prepare('SELECT * FROM works WHERE project_path = ? AND id = ?').get(project, id)!;
    db.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE');
    db.prepare('DELETE FROM works WHERE project_path = ? AND id = ?').run(project, id);
    db.prepare('INSERT INTO works(project_path,id,title,status,updated_at,version,work_json,extra_json) VALUES(?,?,?,?,?,?,?,?)').run(project,id,row['title']!,row['status']!,row['updated_at']!,row['version']!,row['work_json']!,row['extra_json']!);
    db.exec('COMMIT');
  } finally { db.close(); }
  const rejected = await s.sync!.pullMailState(c, { ...key, cursor: first.next! }, 2);
  expect(rejected.result).toEqual({ kind: 'mail-unavailable', reason: 'not-found' });
});


it.each(['equal', 'lower'] as const)('recovers foreign same-key/birth/rowid %s-version incarnation with a new epoch and fresh mail coverage', async kind => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(1900000000000);
  try {
    await seed(); const id = await seed(), c = client('modern', [WORKS_SYNC_FEATURE, ROOMS_MAIL_FEATURE]), s = await service();
    const key = { projectPath: project, workId: id }, epoch = s.sync!.epoch;
    const previous = s.sync!.snapshot(key)!, version = previous.structuralSourceVersion!;
    const db = new Database(path.join(home, 'parley.db'));
    let targetVersion = version;
    try {
      const row = db.prepare('SELECT *, rowid FROM works WHERE project_path = ? AND id = ?').get(project, id)!;
      const work = JSON.parse(String(row['work_json'])); work.goal = 'new incarnation';
      targetVersion = kind === 'lower' ? version - 100 : version;
      db.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE');
      db.prepare('DELETE FROM works WHERE project_path = ? AND id = ?').run(project,id);
      db.prepare('INSERT INTO works(project_path,id,title,status,updated_at,version,work_json,extra_json) VALUES(?,?,?,?,?,?,?,?)').run(project,id,row['title']!,row['status']!,row['updated_at']!,targetVersion,JSON.stringify(work),row['extra_json']!);
      db.exec('COMMIT');
      expect(db.prepare('SELECT rowid FROM works WHERE project_path = ? AND id = ?').get(project,id)!['rowid']).toBe(row['rowid']);
    } finally { db.close(); }
    await vi.waitFor(() => expect(s.sync!.snapshot(key)!.map.work.goal).toBe('new incarnation'), { timeout: 3000 });
    expect(s.sync!.epoch).not.toBe(epoch);
    expect(s.sync!.snapshot(key)!.map.sessions).toEqual([]);
    const fresh = await mail(s, c, id);
    expect(fresh.requiredStructuralVersion).toBeLessThanOrEqual(fresh.sourceVersion);
    expect(fresh.sourceVersion).toBeGreaterThanOrEqual(targetVersion);
    expect(s.windowSnapshot()!.entries.find(entry => entry.map.work.id === id)!.map.work.goal).toBe('new incarnation');
    const stable = s.sync!.epoch;
    await updateMap(project, id, map => { map.work.goal = 'ordinary V+1'; });
    await vi.waitFor(() => expect(s.sync!.snapshot(key)!.map.work.goal).toBe('ordinary V+1'));
    expect(s.sync!.epoch).toBe(stable);
  } finally { vi.useRealTimers(); }
});


it('does not relabel an old transaction notification after foreign recreation before listener delivery', async () => {
  const id = await seed(), c = client('modern', [WORKS_SYNC_FEATURE, ROOMS_MAIL_FEATURE]);
  const db = new Database(path.join(home, 'parley.db')); let armed = false, eventIncarnation = 0;
  const off = onMapWritten(event => {
    if (!armed || event.workId !== id) return;
    armed = false; eventIncarnation = event.incarnation!;
    const row = db.prepare('SELECT * FROM works WHERE project_path = ? AND id = ?').get(project,id)!;
    const work = JSON.parse(String(row['work_json'])); work.goal = 'foreign replacement';
    db.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE');
    db.prepare('DELETE FROM works WHERE project_path = ? AND id = ?').run(project,id);
    db.prepare('INSERT INTO works(project_path,id,title,status,updated_at,version,work_json,extra_json) VALUES(?,?,?,?,?,?,?,?)').run(project,id,row['title']!,row['status']!,row['updated_at']!,row['version']!,JSON.stringify(work),row['extra_json']!);
    db.exec('COMMIT');
  });
  try {
    const s = await service(); c.sent.length = 0; armed = true;
    writeLetters(project,id,letters => letters.add({ kind: 'note', from: 's-01', to: ['human'], roomId: null, text: 'old lifetime journal' }));
    expect(eventIncarnation).toBeLessThan(workIdentity(project,id)!.incarnation);
    await vi.waitFor(() => expect(s.sync!.snapshot({ projectPath: project, workId: id })!.map.work.goal).toBe('foreign replacement'));
    expect(c.sent.filter(value => value.event === 'rooms.mail')).toEqual([]);
    expect((await mail(s,c,id)).mail.unread.letters).toBe(0);
  } finally { off(); db.close(); }
});
