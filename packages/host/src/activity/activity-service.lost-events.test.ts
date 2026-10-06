import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import type { EventsLog } from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import type { HostContext } from '../context.js';
import type { ActivityService } from './activity-service.js';

/**
 * Отдельный файл: здесь наблюдатель журналов не приносит ни одного уведомления. Так выглядит запись,
 * сделанная, пока libuv пересоздавал общий для процесса поток FSEvents (на macOS — на каждом новом
 * наблюдателе каталога): о ней не узнаёт ни один наблюдатель. На настоящей файловой системе это
 * случается раз в десятки запусков, и по заказу такую потерю не воспроизвести.
 *
 * Список сессий провайдера индекс логов строит, пока тест его не отпустит: так видно, когда индекс
 * заводит свои наблюдатели. Чтения журналов считаются.
 */
let reads = 0;
let releaseBuild: () => void = () => {};
let buildGate: Promise<void> = Promise.resolve();

vi.mock('@parley/core', async (importOriginal) => {
  const core = await importOriginal<typeof import('@parley/core')>();
  return {
    ...core,
    watchEvents: () => ({ close: () => {} }),
    openEvents: (eventsDir: string): EventsLog => {
      const journal = core.openEvents(eventsDir);
      return {
        read: (sessionId) => {
          reads += 1;
          return journal.read(sessionId);
        },
      };
    },
    buildAllSessions: async (...args: Parameters<typeof core.buildAllSessions>) => {
      await buildGate;
      return core.buildAllSessions(...args);
    },
  };
});

const { addSession, createWork, hookedSince, transitionSession, updateMap, workPaths } =
  await import('@parley/core');
const { createWorksService } = await import('../works/works-service.js');
const { createActivityService } = await import('./activity-service.js');

let home = '';
let project = '';
let claudeRoot = '';
let codexRoot = '';
let services: Array<{ stop: () => Promise<void> }> = [];

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
  claudeRoot = await mkdtemp(path.join(tmpdir(), 'parley-claude-'));
  codexRoot = await mkdtemp(path.join(tmpdir(), 'parley-codex-'));
  process.env['PARLEY_HOME'] = home;
  reads = 0;
  buildGate = new Promise((resolve) => {
    releaseBuild = resolve;
  });
});

afterEach(async () => {
  await Promise.all(services.map((service) => service.stop()));
  services = [];
  releaseBuild();
  delete process.env['PARLEY_HOME'];
  await Promise.all(
    [home, project, claudeRoot, codexRoot].map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const waitFor = async (check: () => boolean, timeoutMs = 5000): Promise<void> => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('не дождались условия');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** Свежая сессия Claude Code `s-01`, запущенная хостом; каталог `events/` заведён, журнала ещё нет. */
async function freshSession(): Promise<{ ref: SessionRef; journal: string }> {
  const map = await createWork(project, { title: 'Работа' });
  let sessionId = '';
  await updateMap(project, map.work.id, (current) => {
    const created = addSession(current, { provider: 'claude', label: 'план', task: 'сделать' });
    sessionId = created.id;
    created.launchedBy = 'host';
    transitionSession(current, created.id, 'active');
  });
  const events = workPaths(project, map.work.id).events;
  await mkdir(events, { recursive: true });
  return {
    ref: { projectPath: project, workId: map.work.id, sessionId },
    journal: path.join(events, `${sessionId}.jsonl`),
  };
}

async function started(): Promise<ActivityService> {
  const works = createWorksService(fakeHost());
  services.push(works);
  await works.start();
  const activity = createActivityService(fakeHost(), works, {
    silenceThresholdMs: 30_000,
    claudeRoot,
    codexRoot,
  });
  services.push(activity);
  await activity.start();
  return activity;
}

/** Первый хук свежей сессии: без него хост не пускает отправку из окна (`pty.send`, `hookedSince`). */
const SESSION_START = `${JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' })}\n`;

describe('запись журнала, о которой наблюдатель не сообщил', () => {
  it('после нового наблюдателя журналов сервис перечитывает журналы ещё раз — первый хук не теряется', async () => {
    const { ref, journal } = await freshSession();
    const since = Date.now();
    const a = await started();

    // Хук записан, пока поток FSEvents пересоздавался под новый наблюдатель: уведомления нет.
    await appendFile(journal, SESSION_START);
    await waitFor(() => hookedSince(a.get(ref)?.activity, since));
  }, 20_000);

  it('индекс логов завёл наблюдатели позже старта — журналы перечитываются и после них', async () => {
    const { ref, journal } = await freshSession();
    const since = Date.now();
    const a = await started();
    // Первое чтение и повторное после наблюдателя журналов прошли, а индекс ещё строит список сессий
    // (в работе — гигабайты истории, секунды).
    await waitFor(() => reads >= 2);

    // Хук пришёл, когда индекс заводил свои наблюдатели: поток пересоздан снова, уведомления нет.
    await appendFile(journal, SESSION_START);
    releaseBuild();
    await waitFor(() => hookedSince(a.get(ref)?.activity, since));
  }, 20_000);
});
