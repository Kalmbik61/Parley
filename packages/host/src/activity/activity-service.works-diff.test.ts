import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventsLog, WorkEntry } from '@parley/core';
import type { WorksSnapshot } from '@parley/protocol';
import type { HostContext } from '../context.js';
import type { WorksService } from '../works/works-service.js';

/**
 * `works.changed` и activity (карта-журнал, задача 9): пересчитываются только изменившиеся работы, но журнал хуков
 * (`readJournal`) у изменившейся работы дочитывается для КАЖДОЙ её сессии, а у новой работы — при заведении наблюдателя.
 * Это решение ревью: дочитывание закрывает окно между созданием `fs.watch` и его включением, его не урезают ради экономии.
 *
 * Чтения журналов считаются подменой `openEvents`; наблюдатель журналов — заглушка, уведомлений от него нет.
 */
const reads: string[] = [];

vi.mock('@parley/core', async (importOriginal) => {
  const core = await importOriginal<typeof import('@parley/core')>();
  return {
    ...core,
    watchEvents: () => ({ close: () => {} }),
    openEvents: (eventsDir: string): EventsLog => {
      const journal = core.openEvents(eventsDir);
      return {
        read: (sessionId) => {
          reads.push(`${eventsDir}|${sessionId}`);
          return journal.read(sessionId);
        },
      };
    },
  };
});

const { addSession, createWork, readWorks, transitionSession, updateMap, workPaths } = await import('@parley/core');
const { createActivityService } = await import('./activity-service.js');

let home = '';
let project = '';
let claudeRoot = '';
let codexRoot = '';
let stoppers: Array<() => Promise<void>> = [];

const fakeHost = (): HostContext =>
  ({
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
  }) as HostContext;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
  claudeRoot = await mkdtemp(path.join(tmpdir(), 'parley-claude-'));
  codexRoot = await mkdtemp(path.join(tmpdir(), 'parley-codex-'));
  process.env['PARLEY_HOME'] = home;
  reads.length = 0;
});
afterEach(async () => {
  for (const stop of stoppers) await stop();
  stoppers = [];
  delete process.env['PARLEY_HOME'];
  await Promise.all([home, project, claudeRoot, codexRoot].map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Работа с двумя активными сессиями. */
async function work(title: string): Promise<void> {
  const map = await createWork(project, { title });
  await updateMap(project, map.work.id, (current) => {
    for (const label of ['A', 'B']) {
      const created = addSession(current, { provider: 'claude', label, task: 'x' });
      created.launchedBy = 'host';
      transitionSession(current, created.id, 'active');
    }
  });
  // Каталог событий есть заранее: у работы с каталогом наблюдатель включается сразу.
  await mkdir(workPaths(project, map.work.id).events, { recursive: true });
}

/** Ждёт, пока дочитывания после наблюдателей (300/1000/3000 мс) и индекс логов отработают: счёт чтений перестал расти. */
async function quiet(): Promise<void> {
  let last = -1;
  let stableSince = Date.now();
  while (Date.now() - stableSince < 2600) {
    if (reads.length !== last) {
      last = reads.length;
      stableSince = Date.now();
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const sessionsOf = (entry: WorkEntry): string[] =>
  entry.map.sessions.map((session) => `${workPaths(entry.projectPath, entry.map.work.id).events}|${session.id}`);

async function rig() {
  for (const title of ['w1', 'w2', 'w3', 'w4', 'w5']) await work(title);
  const entries = await readWorks(project);
  let current: WorkEntry[] = entries;
  let listener: (snapshot: WorksSnapshot, previous: WorksSnapshot) => void = () => {};
  const onMail = vi.fn(() => () => {});
  const snapshotOf = (list: WorkEntry[]): WorksSnapshot => ({ entries: list, branches: {} });
  const works = {
    snapshot: () => snapshotOf(current),
    entry: (projectPath: string, workId: string) => current.find((e) => e.projectPath === projectPath && e.map.work.id === workId),
    onChange: (fn: typeof listener) => {
      listener = fn;
      return () => {};
    },
    onMail,
  } as unknown as WorksService;
  const activity = createActivityService(fakeHost(), works, { silenceThresholdMs: 30_000, claudeRoot, codexRoot });
  stoppers.push(() => activity.stop());
  await activity.start();
  await quiet();
  reads.length = 0;
  return {
    entries,
    onMail,
    change(next: WorkEntry[]) {
      const before = current;
      current = next;
      listener(snapshotOf(next), snapshotOf(before));
    },
  };
}

describe('activity: works.changed по диффу', () => {
  it('одна изменённая работа из пяти — журнал хуков читается у всех её сессий и больше ни у чьих', async () => {
    const { entries, change, onMail } = await rig();
    const changed = entries[2]!;
    change(entries.map((entry) => (entry === changed ? { ...entry, map: { ...entry.map } } : entry)));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(new Set(reads)).toEqual(new Set(sessionsOf(changed)));
    // письмо активность не меняет: на rooms.mail она не подписана
    expect(onMail).not.toHaveBeenCalled();
  }, 30_000);

  it('нет изменений — журналы не читаются', async () => {
    const { entries, change } = await rig();
    change([...entries]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(reads).toEqual([]);
  }, 30_000);

  it('новая работа в снимке — наблюдатель заводится и журналы её сессий читаются', async () => {
    const { entries, change } = await rig();
    await work('w6');
    const all = await readWorks(project);
    const fresh = all.find((entry) => !entries.some((old) => old.map.work.id === entry.map.work.id))!;
    change([...entries, fresh]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(new Set(reads)).toEqual(new Set(sessionsOf(fresh)));
  }, 30_000);
});
