import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkEntry } from '@harnas/core';
import type { HostContext } from '../context.js';
import type { WorksService } from './works-service.js';

/**
 * Отдельный файл: здесь `watchWorks` подменён, чтобы отдать чтения в нужном
 * порядке. Настоящие наблюдатели порядок не гарантируют, и гонку «старое
 * чтение пришло последним» на файловой системе воспроизвести нечем.
 */
const deliver: Array<(works: WorkEntry[], seq: number) => void> = [];

vi.mock('@harnas/core', async (importOriginal) => {
  const core = await importOriginal<typeof import('@harnas/core')>();
  return {
    ...core,
    watchWorks: (onWorks: (works: WorkEntry[], seq: number) => void) => {
      deliver.push(onWorks);
      return { close: () => {} };
    },
  };
});

const { addSession, createWork, readWorks, transitionSession, updateMap } =
  await import('@harnas/core');
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
  home = await mkdtemp(path.join(tmpdir(), 'harnas-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'harnas-project-'));
  process.env.HARNAS_HOME = home;
  deliver.length = 0;
});

afterEach(async () => {
  await service?.stop();
  service = undefined;
  delete process.env.HARNAS_HOME;
  await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
});

const waitFor = async (check: () => boolean, timeoutMs = 3000): Promise<void> => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('не дождались условия');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe('порядок чтений', () => {
  it('чтение, начатое раньше, но пришедшее позже, свежий снимок не затирает', async () => {
    const a = await createWork(project, { title: 'A' });
    const s = createWorksService(fakeHost(), { debounceMs: 20 });
    service = s;
    await s.start();
    expect(deliver.length).toBeGreaterThanOrEqual(2);

    const onlyA = await readWorks(project);
    await createWork(project, { title: 'B' });
    const both = await readWorks(project);

    // Свежее чтение (номер 11) пришло от одного наблюдателя, следом — старое
    // (номер 10) от другого: в снимке должно остаться свежее.
    deliver[1]?.(both, 11);
    deliver[0]?.(onlyA, 10);
    await waitFor(() => s.snapshot().entries.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(s.snapshot().entries).toHaveLength(2);
    expect(s.snapshot().entries.map((entry) => entry.map.work.id)).toContain(a.work.id);
  });

  it('чтение, сделанное до сверки живости, не возвращает в снимок active мёртвой сессии', async () => {
    // Хост после падения прежнего: в карте active с мёртвым pid. Сверка при старте пишет
    // sleeping, а чтение наблюдателя, начатое до этой записи, приходит после неё — снимок
    // не должен откатиться к active (сверка на диске уже сделана, мёртвых она не найдёт).
    const map = await createWork(project, { title: 'A' });
    await updateMap(project, map.work.id, (current) => {
      const created = addSession(current, { provider: 'claude', label: 'план', task: 't' });
      created.launchedBy = 'host';
      created.pid = 999_999;
      transitionSession(current, created.id, 'active');
    });
    const beforeReconcile = await readWorks(project);

    const s = createWorksService(fakeHost(), { debounceMs: 20 });
    service = s;
    await s.start();
    expect(s.entry(project, map.work.id)?.map.sessions[0]?.lifecycle).toBe('sleeping');

    let refreshed = false;
    s.onChange(() => {
      refreshed = true;
    });
    deliver[0]?.(beforeReconcile, 1);
    await waitFor(() => refreshed);

    expect(s.entry(project, map.work.id)?.map.sessions[0]?.lifecycle).toBe('sleeping');
  });

  it('карта нового проекта, переписанная до его наблюдателя, попадает в снимок', async () => {
    // Первая работа нового проекта: список приходит от наблюдателя дома (индекс), а индекс
    // пишется раньше карты (`updateMap`). Запись карты, сделанная до наблюдателя проекта,
    // иначе не видна никому — сессия навсегда pending в снимке (fix-tests2, attention:63).
    const s = createWorksService(fakeHost(), { debounceMs: 20 });
    service = s;
    await s.start();
    const map = await createWork(project, { title: 'A' });
    let sessionId = '';
    await updateMap(project, map.work.id, (current) => {
      sessionId = addSession(current, { provider: 'claude', label: 'план', task: 't' }).id;
    });
    const beforeLaunch = await readWorks(home);
    await updateMap(project, map.work.id, (current) => {
      const session = current.sessions.find((candidate) => candidate.id === sessionId);
      if (session !== undefined) session.pid = process.pid;
      transitionSession(current, sessionId, 'active');
    });

    let refreshed = false;
    s.onChange(() => {
      refreshed = true;
    });
    deliver[0]?.(beforeLaunch, 100);
    await waitFor(() => refreshed);

    expect(s.entry(project, map.work.id)?.map.sessions[0]?.lifecycle).toBe('active');
  });
});
