import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { addRoom, addSession, createWork, HUMAN, PARLEY, readMap, transitionSession, updateMap } from '@parley/core';
import type { WorkMap } from '@parley/core';
import type { ActivityService } from '../activity/activity-service.js';
import type { HostContext } from '../context.js';
import type { PtyManager } from '../pty/pty-manager.js';
import type { SessionsService } from '../sessions/sessions-service.js';
import type { WorksService } from '../works/works-service.js';
import { createWakeService } from './wake-service.js';

let home = '';
let project = '';
let previous: string | undefined;
beforeEach(async () => {
  home = await mkdtemp('/private/tmp/parley-recipe-wake-');
  previous = process.env['PARLEY_HOME'];
  process.env['PARLEY_HOME'] = home;
  project = path.join(home, 'project');
});
afterEach(async () => {
  if (previous === undefined) delete process.env['PARLEY_HOME'];
  else process.env['PARLEY_HOME'] = previous;
  await rm(home, { recursive: true, force: true });
});

const recipe = { id: 'project:pay', name: 'Payments', playbook: 'Original playbook.' };

/** Работа на диске: s-01 ведёт и закрыт, s-02 спит и принимает письма, s-03 участник. */
async function prepare(): Promise<string> {
  const { work } = await createWork(project, { title: 'Рецепт' });
  await updateMap(project, work.id, (map) => {
    for (const label of ['Lead', 'Next', 'Other']) addSession(map, { provider: 'claude', label, task: 'x' });
    for (const id of ['s-01', 's-02', 's-03']) transitionSession(map, id, 'active');
    transitionSession(map, 's-02', 'sleeping');
    map.sessions[1]!.providerSessionId = 'offline-fixture';
    const room = addRoom(map, { title: 'R', creator: HUMAN, members: ['s-01', 's-02', 's-03'], lead: 's-01', recipe });
    room.recipeLeadNotified = 's-01';
    transitionSession(map, 's-01', 'closed');
  });
  return work.id;
}

/** Будильник поверх карты с диска: `fire()` — «карта изменилась», как событие работ хоста. */
async function rig(workId: string) {
  let map: WorkMap = await readMap(project, workId);
  let listener: () => void = () => {};
  const works = {
    snapshot: () => ({ entries: [{ projectPath: project, map }], branches: {} }),
    entry: () => ({ projectPath: project, map }),
    onChange: (fn: () => void) => { listener = fn; return () => {}; },
  } as unknown as WorksService;
  const activity = { onChange: () => () => {}, mailWaiting: vi.fn() } as unknown as ActivityService;
  const pty = { get: () => undefined, on: () => () => {} } as unknown as PtyManager;
  const host = { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, broadcast: vi.fn() } as unknown as HostContext;
  const launch = vi.fn<SessionsService['launch']>(async () => {});
  const wake = createWakeService(host, works, activity, pty, { launch });
  wake.start();
  return {
    wake, launch,
    async fire() {
      map = await readMap(project, workId);
      listener();
      for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      map = await readMap(project, workId);
      listener();
      for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    },
  };
}

it('новый ведущий получает письмо со снимком один раз и будится им; после перезапуска хоста письма не повторяются', async () => {
  const workId = await prepare();
  const first = await rig(workId);
  await first.fire();
  const map = await readMap(project, workId);
  const letters = map.messages.filter((message) => message.from === PARLEY);
  expect(letters).toHaveLength(1);
  expect(letters[0]).toMatchObject({ to: ['s-02'], text: 'Recipe: Payments — you lead this room.\nOriginal playbook.' });
  expect(first.launch).toHaveBeenCalledTimes(1);
  expect(first.launch.mock.calls[0]![0]).toMatchObject({ sessionId: 's-02' });
  first.wake.stop();

  // Хост перезапущен: тот же диск, новый будильник — письмо уже в карте и второго нет, подъёма тоже.
  const second = await rig(workId);
  await second.fire();
  expect((await readMap(project, workId)).messages.filter((message) => message.from === PARLEY)).toHaveLength(1);
  expect(second.launch).not.toHaveBeenCalled();
  second.wake.stop();
});

it('комната без рецепта писем при смене ведущего не создаёт', async () => {
  const workId = await prepare();
  await updateMap(project, workId, (map) => { map.rooms[0]!.recipe = null; });
  const r = await rig(workId);
  await r.fire();
  expect((await readMap(project, workId)).messages.filter((message) => message.from === PARLEY)).toEqual([]);
  r.wake.stop();
});
