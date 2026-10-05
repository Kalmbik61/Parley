import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addBacklogItem, addProjectMemory, addSession, createWork, setResult, updateMap } from '@parley/core';
import { createHistoryHandlers } from './history.js';

let root: string;
let project: string;
let workId: string;
let previous: string | undefined;
const handlers = createHistoryHandlers();
const search = (params: { query: string; scope?: 'all' | 'memory' | 'sessions' | 'backlog' | 'decisions'; limit?: number }) => handlers['history.search']({ projectPath: project, ...params });
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'parley-history-host-')));
  project = root;
  previous = process.env['PARLEY_HOME']; process.env['PARLEY_HOME'] = path.join(root, 'home');
  workId = (await createWork(project, { title: 'Work' })).work.id;
  await updateMap(project, workId, map => {
    addSession(map, { provider: 'codex', label: 'Lead', task: 'Bounded' });
    map.sessions[0]!.summary = 'Migrated the cache layer\nAll tests pass.';
    setResult(map, 's-01', 'done', '2026-10-05T12:00:00.000Z');
  });
});
afterEach(async () => {
  if (previous === undefined) delete process.env['PARLEY_HOME']; else process.env['PARLEY_HOME'] = previous;
  await rm(root, { recursive: true, force: true });
});

describe('history.search', () => {
  it('находит урок и пункт бэклога: файл относительный, строка и id на месте, абсолютных путей нет', async () => {
    await addProjectMemory(project, { kind: 'lesson', fact: 'PTY tests flake in worktrees with long paths' });
    await addBacklogItem(project, { title: 'Stabilise the pty harness' });
    const found = await search({ query: 'pty' });
    expect(found.total).toBe(2);
    const memory = found.hits.find(row => row.source === 'memory');
    expect(memory).toMatchObject({ file: '.parley/memory.md', id: 'm-001', complete: true });
    expect(memory!.line).toBeGreaterThan(1);
    expect(found.hits.find(row => row.source === 'backlog')).toMatchObject({ file: '.parley/backlog.md', id: 'b-001' });
    expect(JSON.stringify(found)).not.toContain(root);
    expect(found.hits.every(row => !('hash' in row) && !('length' in row))).toBe(true);
  });
  it('итог сессии открывается по работе и сессии, файла у него нет', async () => {
    const found = await search({ query: 'cache layer', scope: 'sessions' });
    expect(found.hits).toMatchObject([{ source: 'sessions', workId, sessionId: 's-01', title: 'Migrated the cache layer' }]);
    expect(found.hits[0]).not.toHaveProperty('file');
  });
  it('область и лимит работают; пустой результат — total 0', async () => {
    await addProjectMemory(project, { kind: 'fact', fact: 'Needle one' });
    await addProjectMemory(project, { kind: 'fact', fact: 'Needle two' });
    expect((await search({ query: 'needle', scope: 'memory', limit: 1 }))).toMatchObject({ total: 2, limit: 1, scope: 'memory' });
    expect((await search({ query: 'needle', scope: 'memory', limit: 1 })).hits).toHaveLength(1);
    expect((await search({ query: 'needle', scope: 'sessions' })).total).toBe(0);
    expect((await search({ query: 'nothing-like-this' })).hits).toEqual([]);
  });
  it('каталоги скиллов не читаются', async () => {
    await mkdir(path.join(project, '.claude', 'skills', 'x'), { recursive: true });
    await writeFile(path.join(project, '.claude', 'skills', 'x', 'SKILL.md'), 'SKILLNEEDLE');
    expect((await search({ query: 'SKILLNEEDLE' })).total).toBe(0);
  });
  it('неверный запрос — bad_request с фиксированным текстом', async () => {
    for (const params of [{ projectPath: 'relative', query: 'x' }, { projectPath: project, query: '' }, { projectPath: project, query: 'x', limit: 31 },
      { projectPath: project, query: 'x', scope: 'skills' }, { projectPath: project, query: 'x', extra: 1 }])
      await expect(handlers['history.search'](params as never)).rejects.toMatchObject({ code: 'bad_request', message: 'Invalid history search request.' });
  });
});

describe('history.search в linked worktree: общий каталог лежит в основной копии', () => {
  const git = (...args: string[]) => promisify(execFile)('git', args);
  let participant: string;
  beforeEach(async () => {
    const main = path.join(root, 'main'); participant = path.join(root, 'participant');
    await mkdir(main);
    await git('init', '-b', 'main', main);
    await git('-C', main, 'config', 'user.name', 'Fixture'); await git('-C', main, 'config', 'user.email', 'fixture@example.invalid');
    await writeFile(path.join(main, 'README.md'), 'Fixture'); await git('-C', main, 'add', 'README.md'); await git('-C', main, 'commit', '-m', 'fixture');
    await git('-C', main, 'worktree', 'add', '-b', 'participant', participant);
    await addProjectMemory(participant, { kind: 'lesson', fact: 'Shared needle lesson' });
    await addBacklogItem(participant, { title: 'Shared needle task' });
  });
  const found = () => handlers['history.search']({ projectPath: participant, query: 'needle' });
  it('находка общего файла: путь внутри общего каталога, признак sharedFile, абсолютных путей нет', async () => {
    const result = await found();
    expect(result.hits.find(row => row.source === 'memory')).toMatchObject({ file: 'memory.md', sharedFile: true, id: 'm-001' });
    expect(result.hits.find(row => row.source === 'backlog')).toMatchObject({ file: 'backlog.md', sharedFile: true, id: 'b-001' });
    expect(result.hits.every(row => row.line === undefined || row.line > 0)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(root);
  });
  it('обычный проект общий признак не ставит: путь от папки проекта', async () => {
    await addProjectMemory(project, { kind: 'lesson', fact: 'Plain needle lesson' });
    const result = await handlers['history.search']({ projectPath: project, query: 'needle' });
    expect(result.hits[0]).toMatchObject({ file: '.parley/memory.md' });
    expect(result.hits[0]).not.toHaveProperty('sharedFile');
  });
});
