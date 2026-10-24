import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkEntry } from '@parley/core';
import type { HostContext } from '../context.js';
import type { WorksService } from './works-service.js';

/**
 * Отдельный файл: `watchWorks` и `reconcileMap` подменены. Наблюдатель отдаёт чтения по команде теста, а сверка
 * живости держится «задвижкой» — так второе обновление снимка гарантированно приходит, пока первое ещё сверяет.
 * На настоящей файловой системе это делали записи самой сверки (разбор 2026-10-14): обновления шли внахлёст и
 * повторяли одну и ту же работу.
 */
const deliver: Array<(works: WorkEntry[], seq: number) => void> = [];
const reconcile = { calls: 0, running: 0, maxRunning: 0, gate: Promise.resolve() };

vi.mock('@parley/core', async (importOriginal) => {
  const core = await importOriginal<typeof import('@parley/core')>();
  return {
    ...core,
    watchWorks: (onWorks: (works: WorkEntry[], seq: number) => void) => {
      deliver.push(onWorks);
      return { close: () => {} };
    },
    reconcileMap: async (...args: Parameters<typeof core.reconcileMap>) => {
      reconcile.calls += 1;
      reconcile.running += 1;
      reconcile.maxRunning = Math.max(reconcile.maxRunning, reconcile.running);
      try {
        await reconcile.gate;
        return await core.reconcileMap(...args);
      } finally {
        reconcile.running -= 1;
      }
    },
  };
});

const { addSession, createWork, readWorks, transitionSession, updateMap } = await import('@parley/core');
const { createWorksService } = await import('./works-service.js');

let home = '';
let project = '';
let service: WorksService | undefined;

function fakeHost(): HostContext {
  return {
    version: '0.0.0',
    startedAt: new Date().toISOString(),
    paths: { dir: '', socket: '', token: '', pid: '', log: '' },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    clients: () => [],
    liveSessions: () => 0,
    broadcast: () => {},
    onShutdown: () => {},
    shutdown: async () => {},
    busy: () => {},
  };
}

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
  process.env.PARLEY_HOME = home;
  deliver.length = 0;
  Object.assign(reconcile, { calls: 0, running: 0, maxRunning: 0, gate: Promise.resolve() });
});

afterEach(async () => {
  await service?.stop();
  service = undefined;
  delete process.env.PARLEY_HOME;
  await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('обновления снимка по одному', () => {
  it('новое обновление ждёт идущее и потом идёт один раз — со свежим списком', async () => {
    const { work } = await createWork(project, { title: 'A' });
    // Сессия с pid — кандидат сверки живости: без неё `reconcileMap` не зовётся.
    await updateMap(project, work.id, (map) => {
      const session = addSession(map, { provider: 'claude', label: 'сессия', task: '' });
      transitionSession(map, session.id, 'active');
      session.pid = 999_999;
    });

    let release!: () => void;
    reconcile.gate = new Promise((resolve) => {
      release = resolve;
    });
    const s = createWorksService(fakeHost(), { debounceMs: 10 });
    service = s;
    const started = s.start();
    await vi.waitFor(() => expect(reconcile.calls).toBe(1));

    // Пока первая сверка держится, наблюдатель дважды приносит новое чтение.
    const works = await readWorks();
    deliver[0]?.(works, 1);
    await sleep(50);
    deliver[0]?.(works, 2);
    await sleep(100);
    expect(reconcile.calls).toBe(1);

    release();
    await started;
    await vi.waitFor(() => expect(reconcile.calls).toBe(2));
    await sleep(100);
    expect(reconcile.calls).toBe(2);
    expect(reconcile.maxRunning).toBe(1);
  });
});
