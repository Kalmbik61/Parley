import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addSession,
  createWork,
  createWorktree,
  plannedWorktree,
  readStoredMap,
  removeWorktreeCopy,
  transitionSession,
  updateMap,
} from '@parley/core';
import type { RemoveCopyResult, WorktreeInfo } from '@parley/core';
import { refKey } from '@parley/protocol';
import type { SessionRef } from '@parley/protocol';
import type { HostContext } from '../context.js';
import { createWorktreesHandlers } from '../methods/worktrees.js';
import type { WorktreesService } from './worktrees-service.js';
import { createWorktreeSweeper } from './worktree-sweeper.js';
import type { WorktreeSweeperDeps } from './worktree-sweeper.js';

const run = promisify(execFile);
const git = (dir: string, args: string[]) => run('git', ['-C', dir, ...args]);

let home = '';
let project = '';
let workId = '';
let logs: Array<{ level: string; msg: string }> = [];
let worksListeners: Array<() => void> = [];
let snapshots = 0;
let windowPresent = true;
let held = new Set<string>();
/** Вызовы подделки `remove`: путь копии и флаг `force`. */
let removed: Array<{ path: string; force: boolean }> = [];
let removeImpl: (info: WorktreeInfo, force: boolean) => Promise<RemoveCopyResult> = async () => ({
  removed: true,
  branchDeleted: true,
});
let guardBusy = new Set<string>();

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-sweeper-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-sweeper-project-'));
  process.env['PARLEY_HOME'] = home;
  workId = '';
  logs = [];
  worksListeners = [];
  snapshots = 0;
  windowPresent = true;
  held = new Set();
  removed = [];
  guardBusy = new Set();
  removeImpl = async () => ({ removed: true, branchDeleted: true });
});

afterEach(async () => {
  delete process.env['PARLEY_HOME'];
  await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
});

const fakeHost = (): HostContext => {
  const write =
    (level: string) =>
    (msg: string): void => {
      logs.push({ level, msg });
    };
  return { log: { info: write('info'), warn: write('warn'), error: write('error') } } as unknown as HostContext;
};

const works: WorktreeSweeperDeps['works'] = {
  snapshot: () => {
    snapshots += 1;
    return { entries: [{ projectPath: project, map: readStoredMap(project, workId) }], branches: {} };
  },
  onChange: (listener) => {
    const wrapped = (): void => listener(undefined as never, undefined as never);
    worksListeners.push(wrapped);
    return () => {
      worksListeners = worksListeners.filter((item) => item !== wrapped);
    };
  },
} as unknown as WorktreeSweeperDeps['works'];

const sessions: WorktreeSweeperDeps['sessions'] = {
  sweepGuard: async (ref, work) => (guardBusy.has(ref.sessionId) ? null : work()),
};

const holds: WorktreeSweeperDeps['holds'] = {
  held: () => held,
  windowPresent: () => windowPresent,
};

function boot(over: Partial<WorktreeSweeperDeps> = {}) {
  return createWorktreeSweeper(fakeHost(), {
    works,
    sessions,
    holds,
    remove: async (_project, info, options) => {
      removed.push({ path: info.path, force: options?.force === true });
      return removeImpl(info, options?.force === true);
    },
    size: async () => 4096,
    isRepo: async () => true,
    now: () => new Date('2026-11-03T12:00:00.000Z'),
    ...over,
  });
}

/** Сессия с созданной по записи копией; `state` — закрыта она или спит. */
async function seed(state: 'closed' | 'sleeping'): Promise<SessionRef> {
  if (workId === '') workId = (await createWork(project, { title: 'Работа' })).work.id;
  let sessionId = '';
  await updateMap(project, workId, (map) => {
    const session = addSession(map, { provider: 'claude', label: 'бэкенд', task: 'сделать' });
    sessionId = session.id;
    session.worktree = {
      ...plannedWorktree(project, workId, session.id, 'main', path.join(home, 'wt')),
      createdAt: '2026-11-03T10:00:00.000Z',
    };
    transitionSession(map, session.id, 'active');
    transitionSession(map, session.id, state);
  });
  return { projectPath: project, workId, sessionId };
}

const infoOf = (ref: SessionRef): WorktreeInfo => {
  const info = readStoredMap(project, workId).sessions.find((session) => session.id === ref.sessionId)?.worktree;
  if (info == null) throw new Error('нет worktree');
  return info;
};

describe('служба уборки копий', () => {
  it('закрытая сессия: копия убрана, в карте removedAt', async () => {
    const ref = await seed('closed');
    const sweeper = boot();
    await sweeper.pass();
    expect(removed.map((call) => call.path)).toEqual([infoOf(ref).path]);
    expect(infoOf(ref).removedAt).toBe('2026-11-03T12:00:00.000Z');
    expect(sweeper.leftovers()).toEqual([]);
  });

  it('без окна ничего не удаляется', async () => {
    await seed('closed');
    windowPresent = false;
    const sweeper = boot();
    await sweeper.pass();
    expect(removed).toEqual([]);
    expect(sweeper.leftovers()).toEqual([]);
  });

  it('несохранённая вкладка: остаток unsaved, remove не вызван', async () => {
    const ref = await seed('closed');
    held = new Set([refKey(ref)]);
    const sweeper = boot();
    await sweeper.pass();
    expect(removed).toEqual([]);
    expect(sweeper.leftovers().map((item) => item.reason)).toEqual(['unsaved']);
    expect(infoOf(ref).removedAt ?? null).toBeNull();
  });

  it('удержание, пришедшее посреди прохода, спасает копию', async () => {
    const ref = await seed('closed');
    let calls = 0;
    const sweeper = boot({
      holds: {
        held: () => {
          calls += 1;
          // Первый вызов — начало прохода, второй — перед самой уборкой под замком.
          return calls >= 2 ? new Set([refKey(ref)]) : new Set<string>();
        },
        windowPresent: () => true,
      },
    });
    await sweeper.pass();
    expect(removed).toEqual([]);
    expect(sweeper.leftovers().map((item) => item.reason)).toEqual(['unsaved']);
  });

  it('проект без git пропускается', async () => {
    await seed('closed');
    const sweeper = boot({ isRepo: async () => false });
    await sweeper.pass();
    await sweeper.pass();
    expect(removed).toEqual([]);
    expect(sweeper.leftovers()).toEqual([]);
    expect(logs.filter((entry) => entry.level === 'warn')).toHaveLength(1);
  });

  it('sweepGuard дал null: без удаления, остаток in-use', async () => {
    const ref = await seed('closed');
    guardBusy.add(ref.sessionId);
    const sweeper = boot();
    await sweeper.pass();
    expect(removed).toEqual([]);
    expect(sweeper.leftovers().map((item) => item.reason)).toEqual(['in-use']);
  });

  it('грязная копия: остаток dirty с files', async () => {
    const ref = await seed('closed');
    removeImpl = async () => ({ removed: false, reason: 'dirty', files: 3 });
    const sweeper = boot();
    await sweeper.pass();
    const [item] = sweeper.leftovers();
    expect(item).toMatchObject({ reason: 'dirty', files: 3, path: infoOf(ref).path, label: 'бэкенд' });
    expect(infoOf(ref).removedAt ?? null).toBeNull();
  });

  it('спящая в открытой комнате не трогается', async () => {
    await seed('sleeping');
    const sweeper = boot();
    await sweeper.pass();
    expect(removed).toEqual([]);
    expect(sweeper.leftovers()).toEqual([]);
  });

  it('изменение во время прохода даёт ровно один повтор', async () => {
    await seed('closed');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    removeImpl = async () => {
      await gate;
      return { removed: false, reason: 'dirty', files: 1 };
    };
    const sweeper = boot({ throttleMs: 0 });
    sweeper.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Три изменения за время одного прохода.
    for (const listener of worksListeners) {
      listener();
      listener();
      listener();
    }
    expect(snapshots).toBe(1);
    release();
    await sweeper.pass();
    sweeper.stop();
    expect(snapshots).toBe(2);
  });

  it('removeCopy невлитую ветку оставляет', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'parley-sweeper-repo-'));
    try {
      await run('git', ['init', '-b', 'main', repo]);
      await git(repo, ['config', 'user.email', 'тест@parley']);
      await git(repo, ['config', 'user.name', 'тест']);
      await writeFile(path.join(repo, '.gitignore'), '.parley/\n', 'utf8');
      await writeFile(path.join(repo, 'README.md'), 'старт\n', 'utf8');
      await git(repo, ['add', '.gitignore', 'README.md']);
      await git(repo, ['commit', '-m', 'первый']);
      const work = await createWork(repo, { title: 'Работа' });
      let sessionId = '';
      let info!: WorktreeInfo;
      await updateMap(repo, work.work.id, (map) => {
        const session = addSession(map, { provider: 'claude', label: 'бэкенд', task: 'т' });
        sessionId = session.id;
        session.worktree = plannedWorktree(repo, work.work.id, session.id, 'main', path.join(home, 'wt'));
        info = session.worktree;
      });
      await createWorktree(repo, info);
      await writeFile(path.join(info.path, 'новое.txt'), 'правка\n', 'utf8');
      await git(info.path, ['config', 'user.email', 'тест@parley']);
      await git(info.path, ['config', 'user.name', 'тест']);
      await git(info.path, ['add', 'новое.txt']);
      await git(info.path, ['commit', '-m', 'невлитый']);
      await updateMap(repo, work.work.id, (map) => {
        const session = map.sessions.find((candidate) => candidate.id === sessionId);
        if (session?.worktree != null) session.worktree.createdAt = new Date().toISOString();
        transitionSession(map, sessionId, 'active');
        transitionSession(map, sessionId, 'closed');
      });
      const ref: SessionRef = { projectPath: repo, workId: work.work.id, sessionId };
      const sweeper = createWorktreeSweeper(fakeHost(), {
        works: {
          snapshot: () => ({ entries: [{ projectPath: repo, map: readStoredMap(repo, work.work.id) }], branches: {} }),
          onChange: () => () => {},
        } as unknown as WorktreeSweeperDeps['works'],
        sessions,
        holds,
        remove: removeWorktreeCopy,
        size: async () => null,
      });
      const result = await sweeper.removeCopy(ref);
      expect(result).toEqual({ removed: true, branchDeleted: false });
      const branches = (await git(repo, ['branch', '--list', info.branch])).stdout;
      expect(branches).toContain(info.branch);
      expect(readStoredMap(repo, work.work.id).sessions[0]?.worktree?.removedAt).toBeTruthy();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('leftovers отдаёт остатки прохода', async () => {
    await seed('closed');
    removeImpl = async () => ({ removed: false, reason: 'dirty', files: 2 });
    const sweeper = boot();
    await sweeper.pass();
    const { worktreesLeftovers } = createWorktreesHandlers({ worktrees: {} as WorktreesService, sweeper });
    const reply = await worktreesLeftovers({}, {} as never);
    expect(reply.items).toHaveLength(1);
    expect(reply.items[0]).toMatchObject({ reason: 'dirty', files: 2 });
  });

  it('removeCopy у незакончившей сессии — bad_request', async () => {
    const ref = await seed('sleeping');
    const sweeper = boot();
    const { worktreesRemoveCopy } = createWorktreesHandlers({ worktrees: {} as WorktreesService, sweeper });
    await expect(worktreesRemoveCopy({ ref }, {} as never)).rejects.toMatchObject({ code: 'bad_request' });
    expect(removed).toEqual([]);
  });

  it('грязная копия не перепроверяется до recheckMs', async () => {
    await seed('closed');
    removeImpl = async () => ({ removed: false, reason: 'dirty', files: 1 });
    const cached = boot();
    await cached.pass();
    await cached.pass();
    expect(removed).toHaveLength(1);
    expect(cached.leftovers()).toHaveLength(1);
    removed = [];
    const fresh = boot({ recheckMs: 0 });
    await fresh.pass();
    await fresh.pass();
    expect(removed).toHaveLength(2);
  });

  it('брошенная ошибка уборки — остаток refused', async () => {
    await seed('closed');
    removeImpl = async () => {
      throw new Error('git сломался');
    };
    const sweeper = boot();
    await sweeper.pass();
    const [item] = sweeper.leftovers();
    expect(item?.reason).toBe('refused');
    expect(item?.message).toContain('git сломался');
  });

  it('разархивированная работа посреди прохода — копия не тронута', async () => {
    await seed('sleeping');
    await updateMap(project, workId, (map) => {
      map.work.status = 'archived';
    });
    const sweeper = boot({
      sessions: {
        sweepGuard: async (_ref, work) => {
          await updateMap(project, workId, (map) => {
            map.work.status = 'active';
          });
          return work();
        },
      },
    });
    await sweeper.pass();
    expect(removed).toEqual([]);
    expect(sweeper.leftovers()).toEqual([]);
  });

  it('частые изменения дают один проход за интервал', async () => {
    await seed('closed');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const sweeper = boot({ throttleMs: 1000 });
      sweeper.start();
      await vi.advanceTimersByTimeAsync(0);
      const before = snapshots;
      for (const listener of worksListeners) {
        listener();
        listener();
        listener();
      }
      await vi.advanceTimersByTimeAsync(999);
      expect(snapshots).toBe(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(snapshots).toBe(before + 1);
      sweeper.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
