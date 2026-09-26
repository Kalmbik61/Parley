import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addSession,
  createWork,
  createWorktree,
  plannedWorktree,
  readMap,
  sessionTag,
  updateMap,
} from '@harnas/core';
import type { WorktreeInfo } from '@harnas/core';
import type { SessionRef } from '@harnas/protocol';
import type { SessionsService } from '../sessions/sessions-service.js';
import { createWorktreesService } from './worktrees-service.js';

const run = promisify(execFile);
const git = (dir: string, args: string[]) => run('git', ['-C', dir, ...args]);

// Машина теста может не иметь глобального user.email/name — коммит без identity
// падает, поэтому она задаётся на каждый репозиторий локально (тот же приём,
// что и в `work/worktree.test.ts` core).
async function setIdentity(dir: string): Promise<void> {
  await git(dir, ['config', 'user.email', 'тест@harnas']);
  await git(dir, ['config', 'user.name', 'тест']);
}

let project = '';

beforeEach(async () => {
  project = await mkdtemp(path.join(tmpdir(), 'harnas-worktrees-svc-project-'));
  await run('git', ['init', '-b', 'main', project]);
  await setIdentity(project);
  // `.harnas/works/<id>/` живёт прямо в каталоге проекта (спецификация
  // 2026-09-02, координация, раздел про `.gitignore`) — без игнора он сделал бы
  // «чистую» базу «грязной» самим своим появлением, а не правкой теста.
  await writeFile(path.join(project, '.gitignore'), '.harnas/\n', 'utf8');
  await writeFile(path.join(project, 'README.md'), 'старт\n', 'utf8');
  await git(project, ['add', '.gitignore', 'README.md']);
  await git(project, ['commit', '-m', 'первый']);
});

afterEach(async () => {
  await rm(project, { recursive: true, force: true });
});

/** Заявка сессии на диске: карта с worktree, план создан и `createWorktree` уже отработал. */
async function sessionWithWorktree(label = 'бэкенд'): Promise<{ ref: SessionRef; info: WorktreeInfo }> {
  const work = await createWork(project, { title: 'Работа', goal: '' });
  const worktreeRoot = await mkdtemp(path.join(tmpdir(), 'harnas-worktrees-svc-root-'));
  let sessionId = '';
  let info!: WorktreeInfo;
  await updateMap(project, work.work.id, (map) => {
    const session = addSession(map, { provider: 'claude', label, task: 'т' });
    sessionId = session.id;
    session.worktree = plannedWorktree(project, work.work.id, session.id, 'main', worktreeRoot);
    info = session.worktree;
  });
  await createWorktree(project, info);
  await updateMap(project, work.work.id, (map) => {
    const session = map.sessions.find((candidate) => candidate.id === sessionId);
    if (session?.worktree !== null && session?.worktree !== undefined) {
      session.worktree.createdAt = new Date().toISOString();
    }
  });
  return { ref: { projectPath: project, workId: work.work.id, sessionId }, info };
}

let stopped: SessionRef[] = [];

/** Сервису для `discard` нужен только `stop` — реального PTY в этих тестах нет. */
function stubSessions(): Pick<SessionsService, 'stop'> {
  return {
    stop: async (ref) => {
      stopped.push(ref);
    },
  };
}

beforeEach(() => {
  stopped = [];
});

describe('available', () => {
  it('git-проект — true, обычный каталог — false', async () => {
    const service = createWorktreesService(stubSessions());
    expect(await service.available(project)).toBe(true);

    const plain = await mkdtemp(path.join(tmpdir(), 'harnas-worktrees-svc-plain-'));
    expect(await service.available(plain)).toBe(false);
    await rm(plain, { recursive: true, force: true });
  });
});

describe('diff → commit → merge (5)', () => {
  it('цепочка проходит: коммит убирает uncommitted, влить даёт merge-коммит с двумя родителями', async () => {
    const { ref, info } = await sessionWithWorktree();
    const service = createWorktreesService(stubSessions());

    await writeFile(path.join(info.path, 'draft.md'), 'черновик\n', 'utf8');

    const beforeCommit = await service.diff(ref);
    expect(beforeCommit.uncommitted).toBe(true);
    expect(beforeCommit.files.map((file) => file.path)).toContain('draft.md');

    const commit = await service.commit(ref, 'бэкенд: черновик');
    expect(commit).toMatch(/^[0-9a-f]{40}$/);

    const afterCommit = await service.diff(ref);
    expect(afterCommit.uncommitted).toBe(false);
    expect(afterCommit.patch).toContain('черновик');

    const result = await service.merge(ref);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const parents = (
        await git(project, ['rev-list', '--parents', '-n', '1', result.commit])
      ).stdout.trim().split(' ');
      expect(parents).toHaveLength(3);
    }
    await expect(readFile(path.join(project, 'draft.md'), 'utf8')).resolves.toContain('черновик');
  });

  it('сообщение слияния — «harnas: влить S<NN> (<ярлык>) из <ветка>»', async () => {
    const { ref, info } = await sessionWithWorktree('моя фича');
    const service = createWorktreesService(stubSessions());
    await writeFile(path.join(info.path, 'x.md'), 'x\n', 'utf8');
    await git(info.path, ['add', 'x.md']);
    await git(info.path, ['commit', '-m', 'x']);

    const result = await service.merge(ref);
    expect(result.ok).toBe(true);

    const message = (await git(project, ['log', '-1', '--pretty=%s'])).stdout.trim();
    expect(message).toBe(`harnas: влить ${sessionTag(ref.sessionId)} (моя фича) из ${info.branch}`);
  });

  it('грязная база — merge отвечает base_dirty', async () => {
    const { ref, info } = await sessionWithWorktree();
    const service = createWorktreesService(stubSessions());
    await writeFile(path.join(info.path, 'x.md'), 'x\n', 'utf8');
    await git(info.path, ['add', 'x.md']);
    await git(info.path, ['commit', '-m', 'x']);
    await writeFile(path.join(project, 'грязь.md'), 'грязь\n', 'utf8');

    const result = await service.merge(ref);
    expect(result).toMatchObject({ ok: false, reason: 'base_dirty' });
  });
});

describe('discard (6)', () => {
  it('останавливает сессию, убирает каталог и ветку, переводит сессию в closed', async () => {
    const { ref, info } = await sessionWithWorktree();
    const service = createWorktreesService(stubSessions());

    await service.discard(ref, false);

    expect(stopped).toContainEqual(ref);
    expect(existsSync(info.path)).toBe(false);
    expect((await git(project, ['branch', '--list', info.branch])).stdout.trim()).toBe('');
    const map = await readMap(ref.projectPath, ref.workId);
    expect(map.sessions.find((s) => s.id === ref.sessionId)?.lifecycle).toBe('closed');
  });

  it('грязный worktree без force — conflict, каталог остаётся', async () => {
    const { ref, info } = await sessionWithWorktree();
    const service = createWorktreesService(stubSessions());
    await writeFile(path.join(info.path, 'черновик.md'), 'черновик\n', 'utf8');

    await expect(service.discard(ref, false)).rejects.toMatchObject({ code: 'conflict' });
    expect(existsSync(info.path)).toBe(true);
  });
});

describe('без своего worktree', () => {
  it('diff/commit/merge/discard сессии без worktree — bad_request', async () => {
    const work = await createWork(project, { title: 'Работа', goal: '' });
    let sessionId = '';
    await updateMap(project, work.work.id, (map) => {
      sessionId = addSession(map, { provider: 'claude', label: 'a', task: 'т' }).id;
    });
    const ref: SessionRef = { projectPath: project, workId: work.work.id, sessionId };
    const service = createWorktreesService(stubSessions());

    await expect(service.diff(ref)).rejects.toMatchObject({ code: 'bad_request' });
    await expect(service.commit(ref, 'm')).rejects.toMatchObject({ code: 'bad_request' });
    await expect(service.merge(ref)).rejects.toMatchObject({ code: 'bad_request' });
    await expect(service.discard(ref, false)).rejects.toMatchObject({ code: 'bad_request' });
  });
});

