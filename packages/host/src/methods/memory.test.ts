import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addProjectMemory, readProjectMemory, rememberProjectMemory } from '@parley/core';
import { createMemoryHandlers } from './memory.js';

let root: string;
let project: string;
let previous: string | undefined;
const handlers = createMemoryHandlers();
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'parley-memory-host-')));
  project = root;
  previous = process.env['PARLEY_HOME']; process.env['PARLEY_HOME'] = path.join(root, 'home');
});
afterEach(async () => {
  if (previous === undefined) delete process.env['PARLEY_HOME']; else process.env['PARLEY_HOME'] = previous;
  await rm(root, { recursive: true, force: true });
});
const get = () => handlers['memory.get']({ projectPath: project });
const FACT = 'PTY tests flake in worktrees with long paths';
const suggest = (fact = FACT, onHumanRequest = false) => rememberProjectMemory(project, { kind: 'lesson', fact, why: 'Seen twice',
  workId: 'w-0001', sessionId: 's-01', ...(onHumanRequest ? { onHumanRequest: true } : {}) });

describe('memory.get', () => {
  it('на свежем проекте пусто и ничего не создаёт', async () => {
    const snapshot = await get();
    expect(snapshot).toMatchObject({ projectPath: project, file: { relativePath: '.parley/memory.md', exists: false }, items: [], suggestions: [], undoable: [] });
    expect(await readdir(project)).not.toContain('.parley');
  });
  it('в обычном проекте признака общего каталога нет, в linked worktree он есть', async () => {
    expect((await get()).file).not.toHaveProperty('shared');
    const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util');
    const git = (...args: string[]) => promisify(execFile)('git', args);
    const main = path.join(root, 'main'), participant = path.join(root, 'participant');
    await mkdir(main); await git('init', '-b', 'main', main);
    await git('-C', main, 'config', 'user.name', 'Fixture'); await git('-C', main, 'config', 'user.email', 'fixture@example.invalid');
    await writeFile(path.join(main, 'README.md'), 'Fixture'); await git('-C', main, 'add', 'README.md'); await git('-C', main, 'commit', '-m', 'fixture');
    await git('-C', main, 'worktree', 'add', '-b', 'participant', participant);
    await addProjectMemory(participant, { kind: 'lesson', fact: 'Needle' });
    expect((await handlers['memory.get']({ projectPath: participant })).file).toEqual({ relativePath: '.parley/memory.md', exists: true, shared: true });
    expect(JSON.stringify(await handlers['memory.get']({ projectPath: participant }))).not.toContain(root + path.sep + 'main');
  });
  it('в снимке нет служебного состояния и абсолютных путей', async () => {
    await suggest();
    const text = JSON.stringify({ ...await get(), projectPath: '' });
    expect(text).not.toMatch(/operations|memorySeq|suggestionSeq|beforeVersion|rowHash/);
    expect(text).not.toContain(root);
  });
});

describe('Suggested: принять, править и принять, отклонить', () => {
  it('предложение агента ждёт; Add кладёт в память с автором-агентом; новая сессия прочтёт её из memory.md', async () => {
    await suggest();
    const before = await get();
    expect(before.items).toEqual([]);
    expect(before.suggestions).toMatchObject([{ id: 'ms-01', kind: 'lesson', fact: FACT, why: 'Seen twice', workId: 'w-0001', sessionId: 's-01' }]);
    const after = await handlers['memory.accept']({ projectPath: project, id: 'ms-01' });
    expect(after.suggestions).toEqual([]);
    expect(after.items).toMatchObject([{ id: 'm-001', kind: 'lesson', fact: FACT, author: 'agent', by: 's-01', onRequest: false, amended: false, state: 'current' }]);
    // Запуск сессии читает ровно эту память.
    expect((await readProjectMemory(project)).items.map(row => row.fact)).toEqual([FACT]);
    expect(await readFile(path.join(project, '.parley', 'memory.md'), 'utf8')).toContain(FACT);
  });
  it('Edit & add кладёт исправленную фразу и помечает правку человека; Dismiss убирает предложение', async () => {
    await suggest();
    await suggest('Second suggestion');
    const accepted = await handlers['memory.accept']({ projectPath: project, id: 'ms-01', fact: 'PTY tests flake in long-path worktrees', details: 'Compare with a baseline run.' });
    expect(accepted.items).toMatchObject([{ fact: 'PTY tests flake in long-path worktrees', details: 'Compare with a baseline run.', author: 'agent', amended: true }]);
    const dismissed = await handlers['memory.dismiss']({ projectPath: project, id: 'ms-02' });
    expect(dismissed.suggestions).toEqual([]); expect(dismissed.items).toHaveLength(1);
    await expect(handlers['memory.accept']({ projectPath: project, id: 'ms-02' })).rejects.toMatchObject({ code: 'bad_request' });
  });
});

describe('Undo записи «по просьбе»', () => {
  it('запись видна с пометкой, Undo убирает её, повтор безвреден', async () => {
    await suggest('Sessions close only with consent', true);
    const snapshot = await get();
    expect(snapshot.items).toMatchObject([{ id: 'm-001', onRequest: true, author: 'agent' }]);
    expect(snapshot.undoable).toMatchObject([{ memoryId: 'm-001', fact: 'Sessions close only with consent', sessionId: 's-01', operationId: 'remember:ms-01' }]);
    const undone = await handlers['memory.undo']({ projectPath: project, operationId: 'remember:ms-01' });
    expect(undone.items).toEqual([]); expect(undone.undoable).toEqual([]);
    expect(await readFile(path.join(project, '.parley', 'memory.md'), 'utf8')).not.toContain('Sessions close');
  });
  it('после правки человека Undo — конфликт, правка сохраняется', async () => {
    await suggest('Sessions close only with consent', true);
    const edited = await handlers['memory.update']({ projectPath: project, id: 'm-001', version: (await get()).version, patch: { fact: 'Sessions close only on explicit consent' } });
    expect(edited.items[0]).toMatchObject({ fact: 'Sessions close only on explicit consent', amended: true });
    await expect(handlers['memory.undo']({ projectPath: project, operationId: 'remember:ms-01' })).rejects.toMatchObject({ code: 'conflict', data: { code: 'memory-conflict' } });
    expect((await get()).items).toHaveLength(1);
  });
});

describe('ручные Add и Edit', () => {
  it('Add записывает пункт человека; повтор той же фразы не дублирует; устаревшая версия — конфликт', async () => {
    const first = await handlers['memory.add']({ projectPath: project, kind: 'fact', fact: 'Build with pnpm build' });
    expect(first.items).toMatchObject([{ id: 'm-001', author: 'human', onRequest: false }]);
    expect((await handlers['memory.add']({ projectPath: project, kind: 'fact', fact: 'BUILD WITH PNPM BUILD' })).items).toHaveLength(1);
    await expect(handlers['memory.add']({ projectPath: project, kind: 'fact', fact: 'Another', version: 'stale' })).rejects.toMatchObject({ code: 'conflict' });
    const second = await handlers['memory.add']({ projectPath: project, kind: 'agreement', fact: 'Close sessions with consent', version: first.version });
    expect(second.items.map(row => row.kind)).toEqual(['fact', 'agreement']);
  });
  it('Edit меняет фразу и подробности по id и версии; устаревшая версия отвергается', async () => {
    const first = await handlers['memory.add']({ projectPath: project, kind: 'fact', fact: 'Build with pnpm' });
    await expect(handlers['memory.update']({ projectPath: project, id: 'm-001', version: 'stale', patch: { fact: 'x' } })).rejects.toMatchObject({ code: 'conflict' });
    const edited = await handlers['memory.update']({ projectPath: project, id: 'm-001', version: first.version, patch: { details: 'Not npm.' } });
    expect(edited.items[0]).toMatchObject({ fact: 'Build with pnpm', details: 'Not npm.' });
  });
});

describe('безопасные отказы', () => {
  it('неверная форма и относительный путь — bad_request с фиксированным текстом', async () => {
    await expect(handlers['memory.get']({ projectPath: 'relative/path' })).rejects.toMatchObject({ code: 'bad_request', message: 'An absolute project path is required.' });
    await expect(handlers['memory.add']({ projectPath: project, kind: 'fact', fact: 'a\nb' } as never)).rejects.toMatchObject({ code: 'bad_request', message: 'Invalid memory request.' });
    await expect(handlers['memory.undo']({ projectPath: project, operationId: '../x' } as never)).rejects.toMatchObject({ code: 'bad_request' });
  });
  it('маркеры конфликта в memory.md — conflict без текста файла', async () => {
    await handlers['memory.add']({ projectPath: project, kind: 'fact', fact: 'Seed' });
    await writeFile(path.join(project, '.parley', 'memory.md'), '# Project memory\n\n## Facts\n<<<<<<< ours\nsecret text\n');
    const error = await get().catch((caught: unknown) => caught as { code: string; message: string; data?: { code: string } });
    expect(error).toMatchObject({ code: 'conflict', message: 'The memory operation could not be completed.', data: { code: 'memory-merge-conflict' } });
    expect(JSON.stringify(error)).not.toContain('secret');
  });
});
