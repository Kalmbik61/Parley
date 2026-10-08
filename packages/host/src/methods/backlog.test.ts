import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addRoom, addSession, createWork, readMap, sharedProjectPaths, suggestBacklog, transitionSession, updateMap, workPaths, worksIndexPath } from '@parley/core';
import { createBacklogHandlers } from './backlog.js';

let root: string;
let project: string;
let previous: string | undefined;
const handlers = createBacklogHandlers();
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'parley-backlog-host-')));
  project = root;
  previous = process.env['PARLEY_HOME']; process.env['PARLEY_HOME'] = path.join(root, 'home');
});
afterEach(async () => {
  if (previous === undefined) delete process.env['PARLEY_HOME']; else process.env['PARLEY_HOME'] = previous;
  await rm(root, { recursive: true, force: true });
});
const get = () => handlers['backlog.get']({ projectPath: project });
const add = (title = 'Fix regression') => handlers['backlog.add']({ projectPath: project, title });
async function target(): Promise<{ projectPath: string; workId: string; roomId: string }> {
  const work = await createWork(project, { title: 'Work' });
  let roomId = '';
  await updateMap(project, work.work.id, map => {
    const session = addSession(map, { provider: 'claude', label: 'Reviewer', task: '' });
    transitionSession(map, session.id, 'active');
    roomId = addRoom(map, { title: 'Room', creator: 'human', members: [session.id] }).id;
  });
  return { projectPath: project, workId: work.work.id, roomId };
}

describe('human backlog handlers', () => {
  it('offers TODOS.md, moves the backlog there and back without touching it', async () => {
    const todos = path.join(project, 'TODOS.md');
    await writeFile(todos, '# TODOS\n');
    expect((await get()).file).toEqual({ relativePath: '.parley/backlog.md', exists: false, choice: null, todos: 'TODOS.md' });
    await add('Moved item');
    const moved = await handlers['backlog.file.set']({ projectPath: project, file: 'todos' });
    expect(moved.file).toEqual({ relativePath: 'TODOS.md', exists: true, choice: 'todos', todos: 'TODOS.md' });
    expect(moved.items.map(item => item.title)).toEqual(['Moved item']);
    await add('Second');
    const before = await readFile(todos, 'utf8'); expect(before).toContain('Second');
    const back = await handlers['backlog.file.set']({ projectPath: project, file: 'state' });
    expect(back.file).toMatchObject({ relativePath: '.parley/backlog.md', exists: false, choice: 'state' });
    expect(await readFile(todos, 'utf8')).toBe(before);
  });
  it('refuses a switch over malformed preferences with a safe error code', async () => {
    await mkdir(path.join(project, '.parley'), { recursive: true });
    await writeFile(path.join(project, '.parley', 'preferences.json'), '{broken');
    await expect(handlers['backlog.file.set']({ projectPath: project, file: 'todos' })).rejects.toMatchObject({ data: { code: 'preferences-invalid' } });
  });
  it('GET missing files is side-effect free and returns only safe projections', async () => {
    const snapshot = await get();
    expect(snapshot).toMatchObject({ projectPath: project, sharedProjectPath: project, file: { exists: false }, items: [], suggestions: [], rule: 'problems' });
    await expect(readFile(path.join(project, '.parley', '.gitignore'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.stringify(snapshot)).not.toMatch(/operations|backlogSeq|source/);
  });
  it('human edits have fresh snapshots and stale writes cannot overwrite them; checked stamps/clears done', async () => {
    const added = await add(); const id = added.items[0]!.id!;
    const changed = await handlers['backlog.update']({ projectPath: project, id, version: added.version, patch: { checked: true } });
    expect(changed.items[0]).toMatchObject({ checked: true, done: new Date().toISOString().slice(0, 10) });
    await expect(handlers['backlog.remove']({ projectPath: project, id, version: added.version })).rejects.toMatchObject({ code: 'conflict', data: { code: 'backlog-conflict' } });
    const reopened = await handlers['backlog.update']({ projectPath: project, id, version: changed.version, patch: { checked: false, title: 'Updated' } });
    expect(reopened.items[0]!.done).toBeUndefined();
    expect(reopened.items[0]!.title).toBe('Updated');
    expect((await handlers['backlog.remove']({ projectPath: project, id, version: reopened.version })).items).toEqual([]);
  });
  it('projects only pending suggestions, honors rule changes, and accepts an edited suggestion', async () => {
    await handlers['backlog.preferences.set']({ projectPath: project, rule: 'ask' });
    await suggestBacklog(project, { kind: 'bug', title: 'Original', why: 'Observed', workId: 'w-01', sessionId: 's-01' });
    const pending = await get(); expect(pending.suggestions).toHaveLength(1);
    const accepted = await handlers['backlog.suggestions.accept']({ projectPath: project, id: pending.suggestions[0]!.id, title: 'Human edit', details: 'Keep details' });
    expect(accepted.suggestions).toEqual([]); expect(accepted.items[0]).toMatchObject({ title: 'Human edit', details: 'Keep details', by: 's-01' });
    await suggestBacklog(project, { kind: 'idea', title: 'Other', why: 'Possible', workId: 'w-01', sessionId: 's-01' });
    const other = await get();
    expect((await handlers['backlog.suggestions.dismiss']({ projectPath: project, id: other.suggestions[0]!.id })).suggestions).toEqual([]);
  });
  it('taken verifies existing live target and is idempotent for that target even after a lost reply', async () => {
    const created = await target(); const added = await add(); const id = added.items[0]!.id!;
    const marked = await handlers['backlog.take']({ projectPath: project, id, version: added.version, target: created });
    expect(marked.items[0]!.taken).toBe(`${created.workId}/${created.roomId}`);
    const retry = await handlers['backlog.take']({ projectPath: project, id, version: added.version, target: created });
    expect(retry.items).toEqual(marked.items);
    expect((await readMap(project, created.workId)).rooms).toHaveLength(1);
  });
  it('unknown, closed, and foreign target failures leave the item unmarked', async () => {
    const created = await target(); const added = await add(); const id = added.items[0]!.id!;
    await expect(handlers['backlog.take']({ projectPath: project, id, version: added.version, target: { ...created, roomId: 'r-99' } })).rejects.toMatchObject({ code: 'not_found' });
    await updateMap(project, created.workId, map => { map.sessions[0]!.lifecycle = 'closed'; });
    await expect(handlers['backlog.take']({ projectPath: project, id, version: added.version, target: created })).rejects.toMatchObject({ code: 'not_found' });
    const foreign = await realpath(await mkdtemp(path.join(tmpdir(), 'parley-backlog-foreign-')));
    try { await expect(handlers['backlog.take']({ projectPath: project, id, version: added.version, target: { ...created, projectPath: foreign } })).rejects.toMatchObject({ code: 'bad_request' }); }
    finally { await rm(foreign, { recursive: true, force: true }); }
    expect((await get()).items[0]!.taken).toBeUndefined();
  });
  it('malformed local data and unsafe inputs produce safe fixed errors without raw content', async () => {
    await add(); const paths = await sharedProjectPaths(project);
    const raw = 'private-secret-parser-value'; await writeFile(paths.preferences, raw);
    const error = await get().catch(value => value);
    expect(error).toMatchObject({ code: 'internal', data: { code: 'preferences-invalid' } });
    expect(error.message).not.toContain(raw); expect(JSON.stringify(error)).not.toContain(project);
    await expect(handlers['backlog.get']({ projectPath: '../secret' })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(handlers['backlog.update']({ projectPath: project, id: 'b-001', version: 'v', patch: { taken: 'w-01/r-01' } } as never)).rejects.toMatchObject({ code: 'bad_request' });
  });
  it('prepareTake assigns the original handwritten row without rewriting long titles or foreign metadata', async () => {
    const paths = await sharedProjectPaths(project); await mkdir(paths.dir);
    const source = `\ufeff# Inbox\r\n- [ ] ${'x'.repeat(4097)} <!-- foreign: keep -->\r\n`;
    await writeFile(paths.backlog, source);
    const before = await get();
    const prepared = await handlers['backlog.prepareTake']({ projectPath: project, index: 0, version: before.version });
    expect(prepared.id).toBe('b-001'); expect(prepared.snapshot.items[0]!.title).toBe(before.items[0]!.title);
    const saved = await readFile(paths.backlog, 'utf8');
    expect(saved.replace(' <!-- b-001 -->', '')).toBe(source);
    const second = await handlers['backlog.prepareTake']({ projectPath: project, id: prepared.id, version: prepared.snapshot.version });
    expect(second.id).toBe(prepared.id); expect(await readFile(paths.backlog, 'utf8')).toBe(saved);
    await writeFile(paths.backlog, `Human edit\n${saved}`);
    await expect(handlers['backlog.prepareTake']({ projectPath: project, id: prepared.id, version: prepared.snapshot.version })).rejects.toMatchObject({ data: { code: 'backlog-conflict' } });
    expect((await get()).items[0]!.taken).toBeUndefined();
  });
  it('GET delivers custom ignore diagnostics after an agent-first write without modifying the ignore', async () => {
    await suggestBacklog(project, { kind: 'bug', title: 'Observed', why: 'Proof', workId: 'w-01', sessionId: 's-01' });
    const paths = await sharedProjectPaths(project); const custom = '\ufeffcustom\r\n';
    await writeFile(path.join(paths.dir, '.gitignore'), custom);
    expect((await get()).diagnostics).toEqual([{ code: 'parley-gitignore-custom' }]);
    expect(await readFile(path.join(paths.dir, '.gitignore'), 'utf8')).toBe(custom);
  });
  it('the assembled snapshot has an aggregate UTF8 bound even when each storage file is small', async () => {
    const paths = await sharedProjectPaths(project); await mkdir(paths.dir);
    await writeFile(paths.backlog, `# ${'a'.repeat(60000)}\n${Array.from({ length: 80 }, (_, index) => `- [ ] Item ${index}\n`).join('')}`);
    await expect(get()).rejects.toMatchObject({ code: 'internal', data: { code: 'backlog-snapshot-too-large' } });
  });
  it('projects an author only from a unique verified same-project map, and never guesses from a foreign map', async () => {
    const created = await target(); const map = await readMap(project, created.workId); const session = map.sessions[0]!;
    await handlers['backlog.preferences.set']({ projectPath: project, rule: 'ask' });
    await suggestBacklog(project, { kind: 'idea', title: 'Suggestion', why: 'Consider', workId: created.workId, sessionId: session.id });
    expect((await get()).suggestions[0]!.author).toMatchObject({ projectPath: project, workId: created.workId, sessionId: session.id, label: 'Reviewer', role: null });
    const foreign = path.join(root, 'foreign'); await mkdir(foreign);
    const foreignWork = await createWork(foreign, { title: 'Other' });
    await updateMap(foreign, foreignWork.work.id, current => { addSession(current, { provider: 'claude', label: 'Foreign', task: '' }); });
    const onlyForeign = { schemaVersion: 1, works: [{ id: created.workId, projectPath: foreign }] };
    await writeFile(worksIndexPath(), JSON.stringify(onlyForeign));
    expect((await get()).suggestions[0]!.author).toBeUndefined();
    // An unsafe intermediate link/unknown map cannot manufacture an author either.
    await writeFile(worksIndexPath(), JSON.stringify({ schemaVersion: 1, works: [{ id: created.workId, projectPath: project }] }));
    await rm(workPaths(project, created.workId).map);
    expect((await get()).suggestions[0]!.author).toBeUndefined();
  });

});


it('ambiguous same-project worktree authors retain IDs without choosing a display identity', async () => {
  const run = (await import('node:util')).promisify((await import('node:child_process')).execFile);
  const main = path.join(root, 'main'), participant = path.join(root, 'participant'); await mkdir(main);
  await run('git', ['init', '-b', 'main', main]); await run('git', ['-C', main, 'config', 'user.name', 'Fixture']); await run('git', ['-C', main, 'config', 'user.email', 'fixture@example.invalid']);
  await writeFile(path.join(main, 'README.md'), 'Fixture'); await run('git', ['-C', main, 'add', 'README.md']); await run('git', ['-C', main, 'commit', '-m', 'fixture']);
  await run('git', ['-C', main, 'worktree', 'add', '-b', 'participant', participant]);
  project = main;
  const source = await createWork(main, { title: 'Source' });
  await updateMap(main, source.work.id, current => { addSession(current, { provider: 'claude', label: 'Main author', task: '' }); });
  // Restored/local legacy maps can share IDs; seed that explicit ambiguity instead of defeating the normal global counter.
  const other = await readMap(main, source.work.id); other.sessions[0]!.label = 'Other author';
  await mkdir(workPaths(participant, source.work.id).dir, { recursive: true });
  await writeFile(workPaths(participant, source.work.id).map, JSON.stringify(other));
  await writeFile(worksIndexPath(), JSON.stringify({ schemaVersion: 1, works: [
    { id: source.work.id, projectPath: main }, { id: source.work.id, projectPath: participant },
  ] }));
  await handlers['backlog.preferences.set']({ projectPath: main, rule: 'ask' });
  await suggestBacklog(main, { kind: 'idea', title: 'Ambiguous', why: 'Observed', workId: source.work.id, sessionId: 's-01' });
  expect((await get()).suggestions[0]).toMatchObject({ workId: source.work.id, sessionId: 's-01' });
  expect((await get()).suggestions[0]!.author).toBeUndefined();
});


it.each(['pending', 'sleeping'] as const)('accepts a known %s session target without fabricating active PTY proof', async lifecycle => {
  const created = await target();
  await updateMap(project, created.workId, map => { map.sessions[0]!.lifecycle = lifecycle; });
  const added = await add();
  const marked = await handlers['backlog.take']({ projectPath: project, id: added.items[0]!.id!, version: added.version,
    target: { projectPath: project, workId: created.workId, sessionId: 's-01' } });
  expect(marked.items[0]!.taken).toBe(`${created.workId}/s-01`);
});
it('uses canonical room liveness including a sleeping creator-only room, but refuses all-closed/deleted rooms', async () => {
  const created = await target();
  await updateMap(project, created.workId, map => { map.rooms[0]!.creator = 's-01'; map.rooms[0]!.members = []; map.sessions[0]!.lifecycle = 'sleeping'; });
  const added = await add();
  expect((await handlers['backlog.take']({ projectPath: project, id: added.items[0]!.id!, version: added.version, target: created })).items[0]!.taken).toBe(`${created.workId}/${created.roomId}`);
  await updateMap(project, created.workId, map => { map.sessions[0]!.lifecycle = 'closed'; });
  const next = await add('Second'); const item = next.items[1]!;
  await expect(handlers['backlog.take']({ projectPath: project, id: item.id!, version: next.version, target: created })).rejects.toMatchObject({ code: 'not_found' });
  expect((await get()).items[1]!.taken).toBeUndefined();
});
