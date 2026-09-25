import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addSession,
  createWork,
  transitionSession,
  updateMap,
  workPaths,
} from '@harnas/core';
import type { EventData, EventName } from '@harnas/protocol';
import type { HostContext } from '../context.js';
import { createWorksService } from './works-service.js';
import type { WorksService } from './works-service.js';

let home = '';
let projectA = '';
let projectB = '';
let broadcasts: Array<{ event: EventName; data: unknown }>;
let services: WorksService[] = [];

/** Минимальный `HostContext` для сервиса: ему нужны только `log` и `broadcast`. */
function fakeHost(): HostContext {
  return {
    version: '0.0.0',
    startedAt: new Date().toISOString(),
    paths: { dir: '', socket: '', token: '', pid: '', log: '' },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    clients: () => [],
    liveSessions: () => 0,
    broadcast: (event, data) => broadcasts.push({ event, data: data as EventData<EventName> }),
    onShutdown: () => {},
    shutdown: async () => {},
    busy: () => {},
  };
}

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'harnas-home-'));
  projectA = await mkdtemp(path.join(tmpdir(), 'harnas-project-a-'));
  projectB = await mkdtemp(path.join(tmpdir(), 'harnas-project-b-'));
  process.env.HARNAS_HOME = home;
  broadcasts = [];
});

afterEach(async () => {
  await Promise.all(services.map((service) => service.stop()));
  services = [];
  delete process.env.HARNAS_HOME;
  await Promise.all([home, projectA, projectB].map((dir) => rm(dir, { recursive: true, force: true })));
});

function service(options: Parameters<typeof createWorksService>[1] = {}): WorksService {
  const created = createWorksService(fakeHost(), options);
  services.push(created);
  return created;
}

const exists = async (file: string): Promise<boolean> => {
  try {
    await readFile(file, 'utf8');
    return true;
  } catch {
    return false;
  }
};

describe('источники', () => {
  it('две работы в двух проектах из индекса попадают в один снимок', async () => {
    const a = await createWork(projectA, { title: 'Работа A' });
    const b = await createWork(projectB, { title: 'Работа B' });

    const s = service();
    await s.start();

    const ids = s.snapshot().entries.map((entry) => `${entry.projectPath}:${entry.map.work.id}`);
    expect(ids.sort()).toEqual([`${projectA}:${a.work.id}`, `${projectB}:${b.work.id}`].sort());
  });

  it('новая работа появляется не позже debounceMs + 50 мс', async () => {
    const s = service({ debounceMs: 50 });
    await s.start();
    expect(s.snapshot().entries).toHaveLength(0);

    const work = await createWork(projectA, { title: 'Свежая' });

    await new Promise((resolve) => setTimeout(resolve, 100));
    const ids = s.snapshot().entries.map((entry) => entry.map.work.id);
    expect(ids).toContain(work.work.id);
  });

  it('новый проект в индексе подхватывается', async () => {
    const s = service({ debounceMs: 50 });
    await s.start();

    const brandNewProject = await mkdtemp(path.join(tmpdir(), 'harnas-project-new-'));
    try {
      const work = await createWork(brandNewProject, { title: 'Новый проект' });
      await new Promise((resolve) => setTimeout(resolve, 300));

      const entry = s.entry(brandNewProject, work.work.id);
      expect(entry?.map.work.title).toBe('Новый проект');
    } finally {
      await rm(brandNewProject, { recursive: true, force: true });
    }
  });
});

describe('живость', () => {
  it('карта с active-сессией мёртвого pid после старта становится exited', async () => {
    const map = await createWork(projectA, { title: 'Работа' });
    await updateMap(projectA, map.work.id, (current) => {
      const created = addSession(current, { provider: 'claude', label: 'план', task: 't' });
      created.launchedBy = 'tui';
      created.pid = 999_999;
      transitionSession(current, created.id, 'active');
    });

    const s = service();
    await s.start();

    const entry = s.entry(projectA, map.work.id);
    expect(entry?.map.sessions[0]?.status).toBe('exited');
  });
});

describe('аренда', () => {
  it('файлы есть у всех работ после старта и исчезают после stop', async () => {
    const a = await createWork(projectA, { title: 'A' });
    const b = await createWork(projectB, { title: 'B' });

    const s = service();
    await s.start();

    expect(await exists(path.join(workPaths(projectA, a.work.id).dir, 'host.lease'))).toBe(true);
    expect(await exists(path.join(workPaths(projectB, b.work.id).dir, 'host.lease'))).toBe(true);

    await s.stop();
    services = services.filter((candidate) => candidate !== s);

    expect(await exists(path.join(workPaths(projectA, a.work.id).dir, 'host.lease'))).toBe(false);
    expect(await exists(path.join(workPaths(projectB, b.work.id).dir, 'host.lease'))).toBe(false);
  });

  it('хост не пишет ничего вне .harnas/works/<id>/ и своего каталога', async () => {
    const a = await createWork(projectA, { title: 'A' });
    const s = service();
    await s.start();

    expect((await readdir(workPaths(projectA, a.work.id).dir)).sort()).toEqual(
      ['artifacts', 'briefs', 'host.lease', 'map.json', 'map.json.bak'].sort(),
    );
  });
});

describe('лок', () => {
  it('занятый map.lock уходит host.notice(map-lock) и не роняет сервис; на следующем изменении проходит', async () => {
    const map = await createWork(projectA, { title: 'Работа' });
    await updateMap(projectA, map.work.id, (current) => {
      const created = addSession(current, { provider: 'claude', label: 'план', task: 't' });
      created.launchedBy = 'tui';
      created.pid = 999_999;
      transitionSession(current, created.id, 'active');
    });
    const lockFile = workPaths(projectA, map.work.id).lock;
    await writeFile(lockFile, '', { flag: 'wx' });

    const s = service({ lockTimeoutMs: 50, debounceMs: 50 });
    await s.start();

    expect(broadcasts.some((b) => b.event === 'host.notice')).toBe(true);
    expect(s.entry(projectA, map.work.id)?.map.sessions[0]?.status).toBe('active');

    await rm(lockFile, { force: true });
    broadcasts = [];
    // Любое дальнейшее изменение индекса запускает следующий цикл.
    await createWork(projectB, { title: 'Толчок' });
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(s.entry(projectA, map.work.id)?.map.sessions[0]?.status).toBe('exited');
  });
});

describe('битая карта', () => {
  it('map.json с мусором даёт один host.notice(map-corrupt) с путём и не переписывается', async () => {
    const map = await createWork(projectA, { title: 'Работа' });
    const mapFile = workPaths(projectA, map.work.id).map;
    const before = await readFile(mapFile, 'utf8');
    await writeFile(mapFile, 'мусор, не json', 'utf8');

    const s = service({ debounceMs: 50 });
    await s.start();

    const notices = broadcasts.filter((b) => b.event === 'host.notice');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.data).toMatchObject({ kind: 'map-corrupt', text: mapFile });
    expect(await readFile(mapFile, 'utf8')).toBe('мусор, не json');
    expect(before).not.toBe('мусор, не json');

    // Второй цикл — карта всё ещё битая, но повторного уведомления нет.
    await createWork(projectB, { title: 'Толчок' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(broadcasts.filter((b) => b.event === 'host.notice')).toHaveLength(1);
  });
});
