import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventsLog } from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import type { HostContext } from '../context.js';
import { WATCH_SETTLE_MS } from '../watch-settle.js';
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
const rescanCalls: string[][] = [];
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

vi.mock('./log-index.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./log-index.js')>();
  return {
    ...original,
    createLogIndex: (...args: Parameters<typeof original.createLogIndex>) => {
      const created = original.createLogIndex(...args);
      const rescan = created.rescan.bind(created);
      created.rescan = (files) => {
        rescanCalls.push([...files]);
        rescan(files);
      };
      return created;
    },
  };
});

const { addSession, createWork, hookedSince, transitionSession, updateMap, workPaths } =
  await import('@parley/core');
const { createWorksService } = await import('../works/works-service.js');
const { SAFETY_RESCAN_MS, createActivityService } = await import('./activity-service.js');

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
  rescanCalls.length = 0;
  buildGate = new Promise((resolve) => {
    releaseBuild = resolve;
  });
});

afterEach(async () => {
  await Promise.all(services.map((service) => service.stop()));
  services = [];
  // Поддельные часы страховки (`setInterval`) снимаются после остановки служб.
  vi.useRealTimers();
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
    // Первое чтение и все дочитывания после наблюдателя журналов прошли, а индекс ещё строит список сессий
    // (в работе — гигабайты истории, секунды).
    await waitFor(() => reads >= 1 + WATCH_SETTLE_MS.length, 10_000);

    // Хук пришёл, когда индекс заводил свои наблюдатели: поток пересоздан снова, уведомления нет.
    await appendFile(journal, SESSION_START);
    releaseBuild();
    await waitFor(() => hookedSince(a.get(ref)?.activity, since));
  }, 20_000);
});

/** Как `started`, но интервал страховки (`SAFETY_RESCAN_MS`) идёт по поддельным часам: ставятся после `works.start()`. */
async function startedWithFakeInterval(): Promise<ActivityService> {
  const works = createWorksService(fakeHost());
  services.push(works);
  await works.start();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const activity = createActivityService(fakeHost(), works, {
    silenceThresholdMs: 30_000,
    claudeRoot,
    codexRoot,
  });
  services.push(activity);
  await activity.start();
  return activity;
}

describe('страховка раз в SAFETY_RESCAN_MS', () => {
  it('подхватывает хук активной сессии, о котором наблюдатель не сообщил', async () => {
    const { ref, journal } = await freshSession();
    const since = Date.now();
    const a = await startedWithFakeInterval();
    // Первое чтение и дочитывания после нового наблюдателя прошли (индекс логов закрыт воротами).
    await waitFor(() => reads >= 1 + WATCH_SETTLE_MS.length, 10_000);

    await appendFile(journal, SESSION_START);
    expect(hookedSince(a.get(ref)?.activity, since)).toBe(false);
    vi.advanceTimersByTime(SAFETY_RESCAN_MS);
    await waitFor(() => hookedSince(a.get(ref)?.activity, since));
  }, 20_000);

  it('читает журналы только активных сессий', async () => {
    const { ref } = await freshSession();
    await updateMap(project, ref.workId, (current) => {
      for (let index = 0; index < 3; index += 1) {
        const created = addSession(current, { provider: 'claude', label: `закрытая ${index}`, task: 'сделать' });
        created.launchedBy = 'host';
        transitionSession(current, created.id, 'active');
        transitionSession(current, created.id, 'closed');
      }
    });
    await startedWithFakeInterval();
    // Первый проход читает все четыре журнала, дочитывания — только журнал активной сессии.
    await waitFor(() => reads >= 4 + WATCH_SETTLE_MS.length, 10_000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const base = reads;

    vi.advanceTimersByTime(SAFETY_RESCAN_MS);
    await waitFor(() => reads > base);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(reads - base).toBe(1);
  }, 20_000);

  it('сессия ожила в работе без наблюдателя: первый хук без уведомления не теряется', async () => {
    const { ref, journal } = await freshSession();
    await updateMap(project, ref.workId, (current) => {
      transitionSession(current, ref.sessionId, 'sleeping');
    });
    const since = Date.now();
    const a = await started();
    await waitFor(() => a.get(ref) !== undefined);

    await updateMap(project, ref.workId, (current) => {
      transitionSession(current, ref.sessionId, 'active');
    });
    await appendFile(journal, SESSION_START);
    await waitFor(() => hookedSince(a.get(ref)?.activity, since));
  }, 20_000);

  it('страховка просит перечитать логи только активных сессий не Codex', async () => {
    const claudeDir = path.join(claudeRoot, '-proj');
    await mkdir(claudeDir, { recursive: true });
    const claudeLog = (id: string): string => path.join(claudeDir, `${id}.jsonl`);
    const claudeLine = (id: string): string =>
      `${JSON.stringify({ type: 'custom-title', customTitle: 'заголовок', sessionId: id })}\n`;
    const codexDir = path.join(codexRoot, '2026', '10', '04');
    await mkdir(codexDir, { recursive: true });
    const codexId = 'codex-live-1';
    await writeFile(
      path.join(codexDir, `rollout-2026-10-04T12-00-00-${codexId}.jsonl`),
      `${JSON.stringify({ type: 'session_meta', timestamp: '2026-10-04T12:00:00.000Z', payload: { id: codexId, cwd: '/codex', source: 'cli' } })}\n`,
    );
    await writeFile(claudeLog('claude-live-1'), claudeLine('claude-live-1'));
    await writeFile(claudeLog('claude-closed-1'), claudeLine('claude-closed-1'));

    const { ref } = await freshSession();
    await updateMap(project, ref.workId, (current) => {
      current.sessions.find((item) => item.id === ref.sessionId)!.providerSessionId = 'claude-live-1';
      const closed = addSession(current, { provider: 'claude', label: 'закрытая', task: 'сделать' });
      closed.launchedBy = 'host';
      transitionSession(current, closed.id, 'active');
      transitionSession(current, closed.id, 'closed');
      closed.providerSessionId = 'claude-closed-1';
      const codex = addSession(current, { provider: 'codex', label: 'codex', task: 'сделать' });
      codex.launchedBy = 'host';
      transitionSession(current, codex.id, 'active');
      codex.providerSessionId = codexId;
    });
    await startedWithFakeInterval();
    releaseBuild();
    // Индекс логов готов: на его первый список служба дочитывает журналы, а `rescan` уже вызван страховкой.
    await waitFor(() => rescanCalls.length > 0, 10_000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const before = rescanCalls.length;

    vi.advanceTimersByTime(SAFETY_RESCAN_MS);
    await waitFor(() => rescanCalls.length > before);
    expect(rescanCalls.at(-1)).toEqual([claudeLog('claude-live-1')]);
  }, 20_000);
});
