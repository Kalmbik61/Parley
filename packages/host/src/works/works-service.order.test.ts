import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkEntry } from '@parley/core';
import type { HostContext } from '../context.js';
import type { WorksService } from './works-service.js';

/**
 * Отдельный файл: здесь `watchWorks` подменён, чтобы отдать чтения в нужном
 * порядке. Настоящие наблюдатели порядок не гарантируют, и гонку «старое
 * чтение пришло последним» на файловой системе воспроизвести нечем.
 */
const deliver: Array<(works: WorkEntry[], seq: number) => void> = [];

vi.mock('@parley/core', async (importOriginal) => {
  const core = await importOriginal<typeof import('@parley/core')>();
  return {
    ...core,
    watchWorks: (onWorks: (works: WorkEntry[], seq: number) => void) => {
      deliver.push(onWorks);
      return { close: () => {} };
    },
  };
});

const { addRoom, addSession, createWork, readWorks, transitionSession, updateMap, workVersion, writeLetters } =
  await import('@parley/core');
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
});

afterEach(async () => {
  await service?.stop();
  service = undefined;
  delete process.env.PARLEY_HOME;
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
    // Источник изменений один на всю базу (спека хранилища 6.9): наблюдателей по проектам больше нет.
    expect(deliver).toHaveLength(1);

    const onlyA = await readWorks();
    await createWork(project, { title: 'B' });
    const both = await readWorks();

    // Свежее чтение (номер 11) пришло раньше, следом — старое (номер 10):
    // в снимке должно остаться свежее.
    deliver[0]?.(both, 11);
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
    const beforeReconcile = await readWorks();

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

  // Находка I2 итогового ревью: список, начатый до письма, возвращается после того, как хост уже перечитал запись работы под
  // письмо; наблюдатель ядра отсеивает только чтения старее принятого, а это — новее по номеру, но старее по версии работы.
  it('чтение списка, начатое до письма, не откатывает запись работы', async () => {
    const map = await createWork(project, { title: 'A' });
    await updateMap(project, map.work.id, (current) => {
      addRoom(current, { title: 'Комната', creator: 'human', members: [], lead: null });
    });
    const s = createWorksService(fakeHost(), { debounceMs: 20 });
    service = s;
    await s.start();
    const started = s.entry(project, map.work.id)?.version;
    expect(started).toBeDefined();

    // Чтение списка началось до письма и ещё в пути.
    const before = await readWorks();
    writeLetters(project, map.work.id, (letters) => {
      letters.add({ kind: 'note', from: 'human', to: [], roomId: 'r-01', text: 'письмо' });
    });
    const after = workVersion(project, map.work.id);
    expect(after).toBeGreaterThan(started!);
    // Пачка писем уходит через `MAIL_BATCH_MS`, и тогда запись работы перечитывается под письмо.
    await waitFor(() => s.entry(project, map.work.id)?.version === after);

    let refreshed = false;
    s.onChange(() => {
      refreshed = true;
    });
    deliver[0]?.(before, 5);
    await waitFor(() => refreshed);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(s.entry(project, map.work.id)?.version).toBe(after);
    expect(s.windowSnapshot().entries.find((entry) => entry.map.work.id === map.work.id)?.version).toBe(after);
  });
});
