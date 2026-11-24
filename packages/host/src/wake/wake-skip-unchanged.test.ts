/**
 * Проход будильника по изменению работ (`recomputeAll(true)`) пропускает работы с той же определённой версией и тем же
 * созданием; без точной версии, на старте и по снятию паузы пересчитывается всё.
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { addSession, createWork, readMap, transitionSession, updateMap, type WorkEntry } from '@parley/core';
import type { HostContext } from '../context.js';
import type { ActivityService } from '../activity/activity-service.js';
import type { WindowCounters } from '../health/window-counters.js';
import type { WorksService } from '../works/works-service.js';
import type { PtyManager } from '../pty/pty-manager.js';
import type { SessionsService } from '../sessions/sessions-service.js';
import { createWakeService } from './wake-service.js';

let root = '';
let project = '';
let previous: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'parley-wake-skip-'));
  project = path.join(root, 'project');
  await mkdir(project);
  await mkdir(path.join(root, 'home'));
  previous = process.env['PARLEY_HOME'];
  process.env['PARLEY_HOME'] = path.join(root, 'home');
});

afterEach(async () => {
  if (previous === undefined) delete process.env['PARLEY_HOME'];
  else process.env['PARLEY_HOME'] = previous;
  await rm(root, { recursive: true, force: true });
});

/** Работа с `count` закрытыми сессиями: пересчёт им ничего не делает, нужен только счёт вызовов. */
async function makeEntry(title: string, count: number, exact: boolean): Promise<WorkEntry> {
  const workId = (await createWork(project, { title })).work.id;
  await updateMap(project, workId, (map) => {
    for (let n = 0; n < count; n += 1) {
      const session = addSession(map, { provider: 'claude', label: 'сессия', task: 'сделать' });
      transitionSession(map, session.id, 'active');
      transitionSession(map, session.id, 'closed');
    }
  });
  const entry = { projectPath: project, map: await readMap(project, workId) } as WorkEntry;
  if (exact) {
    entry.version = 1;
    entry.incarnation = 1;
  }
  return entry;
}

async function rig(entries: WorkEntry[]) {
  let onChange: () => void = () => {};
  const works = {
    snapshot: () => ({ entries, branches: {} }),
    entry: (projectPath: string, workId: string) =>
      entries.find((entry) => entry.projectPath === projectPath && entry.map.work.id === workId),
    onChange: (fn: () => void) => {
      onChange = fn;
      return () => {};
    },
    onMail: () => () => {},
  } as unknown as WorksService;
  const activity = { onChange: () => () => {}, mailWaiting: vi.fn() } as unknown as ActivityService;
  const pty = { get: () => undefined, on: () => () => {} } as unknown as PtyManager;
  const host = { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, broadcast: vi.fn() } as unknown as HostContext;
  const recompute = vi.fn();
  const windowCounters = { recompute } as unknown as WindowCounters;
  const wake = createWakeService(host, works, activity, pty, { launch: vi.fn<SessionsService['launch']>(async () => undefined as never) }, { windowCounters });
  wake.start();
  return { wake, recompute, change: () => onChange() };
}

it('изменилась версия работы A: пересчитываются её сессии, сессии работы B — нет', async () => {
  const a = await makeEntry('A', 2, true);
  const b = await makeEntry('B', 3, true);
  const { wake, recompute, change } = await rig([a, b]);
  expect(recompute).toHaveBeenCalledTimes(5); // старт пересчитывает всё
  recompute.mockClear();

  change(); // ничего не менялось
  expect(recompute).not.toHaveBeenCalled();

  a.version = 2;
  change();
  expect(recompute).toHaveBeenCalledTimes(2);
  wake.stop();
});

it('новое создание работы при той же версии пересчитывается', async () => {
  const a = await makeEntry('A', 2, true);
  const { wake, recompute, change } = await rig([a]);
  recompute.mockClear();
  a.incarnation = 2;
  change();
  expect(recompute).toHaveBeenCalledTimes(2);
  wake.stop();
});

it('работа без точной версии пересчитывается на каждом проходе', async () => {
  const a = await makeEntry('A', 2, false);
  const b = await makeEntry('B', 3, false);
  const { wake, recompute, change } = await rig([a, b]);
  recompute.mockClear();
  change();
  change();
  expect(recompute).toHaveBeenCalledTimes(10);
  wake.stop();
});

it('снятие паузы пересчитывает все работы, даже не менявшиеся', async () => {
  const a = await makeEntry('A', 2, true);
  const { wake, recompute } = await rig([a]);
  wake.pause();
  recompute.mockClear();
  wake.resume();
  expect(recompute).toHaveBeenCalledTimes(2);
  wake.stop();
});
