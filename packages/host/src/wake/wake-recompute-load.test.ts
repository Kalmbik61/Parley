/**
 * Пересчёт будильника не нагружает кэш карт (спека хранилища 6.2): он идёт для каждой сессии каждой работы на каждое
 * изменение работ, а кэш карт ядра держит всего `MAP_CACHE_LIMIT` записей. Если бы непрочитанное читалось из базы, при
 * числе работ больше кэша каждый проход загружал бы карты заново (замер: около 6 мс на промах, 240 мс на проход при 40 работах).
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { addSession, createWork, readMap, transitionSession, updateMap, type WorkEntry } from '@parley/core';
import type { HostContext } from '../context.js';
import type { ActivityService } from '../activity/activity-service.js';
import type { WorksService } from '../works/works-service.js';
import type { PtyManager } from '../pty/pty-manager.js';
import type { SessionsService } from '../sessions/sessions-service.js';
// Счётчик кэша карт ядра — только для тестов, из пакета он не экспортируется; тот же экземпляр модуля, что у `@parley/core`.
import { MAP_CACHE_LIMIT, mapCacheStats } from '../../../core/dist/work/store.js';
import { createWakeService } from './wake-service.js';

const WORKS = MAP_CACHE_LIMIT + 8;

let root = '';
let project = '';
let previous: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'parley-wake-load-'));
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

it('проход по сорока работам с непрочитанным письмом не загружает и не перебирает карты базы', async () => {
  const entries: WorkEntry[] = [];
  for (let n = 0; n < WORKS; n += 1) {
    const workId = (await createWork(project, { title: `Работа ${n}` })).work.id;
    await updateMap(project, workId, (map, letters) => {
      const session = addSession(map, { provider: 'claude', label: 'сессия', task: 'сделать' });
      session.launchedBy = 'host';
      transitionSession(map, session.id, 'active');
      letters.add({ roomId: null, from: 's-00', to: [session.id], text: 'письмо', kind: 'note' });
    });
    entries.push({ projectPath: project, map: await readMap(project, workId) } as WorkEntry);
  }
  // Кэш держит последние `MAP_CACHE_LIMIT` карт: первая уже вытеснена, и её чтение из базы — промах (проверка счётчика).
  const probe = mapCacheStats();
  await readMap(project, entries[0]!.map.work.id);
  expect(mapCacheStats().misses).toBe(probe.misses + 1);

  let onChange: (() => void) | undefined;
  const works = {
    snapshot: () => ({ entries, branches: {} }),
    entry: (projectPath: string, workId: string) =>
      entries.find((entry) => entry.projectPath === projectPath && entry.map.work.id === workId),
    onChange: (listener: () => void) => {
      onChange = listener;
      return () => {};
    },
  } as unknown as WorksService;
  const activity = { onChange: () => () => {}, mailWaiting: vi.fn() } as unknown as ActivityService;
  const pty = { get: () => undefined, on: () => () => {} } as unknown as PtyManager;
  const host = { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, broadcast: vi.fn() } as unknown as HostContext;
  const launch = vi.fn<SessionsService['launch']>(async () => {});
  const wake = createWakeService(host, works, activity, pty, { launch });

  const before = mapCacheStats();
  wake.start(); // первая встреча с работами: непрочитанное считается «указанным»
  onChange?.(); // один пересчёт всех сессий всех работ
  await new Promise((resolve) => setTimeout(resolve, 20));
  wake.stop();

  expect(onChange).toBeDefined();
  expect(launch).not.toHaveBeenCalled();
  expect(mapCacheStats()).toEqual(before);
});
