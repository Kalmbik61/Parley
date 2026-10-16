import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addRoom, addSession, createWork, HUMAN, readMap, transitionSession, updateMap } from '@parley/core';
import type { WorkMap } from '@parley/core';
import type { ActivityService } from '../activity/activity-service.js';
import type { HostContext } from '../context.js';
import type { WindowCounters } from '../health/window-counters.js';
import type { PtyManager } from '../pty/pty-manager.js';
import type { SessionsService } from '../sessions/sessions-service.js';
import type { RoomMail, WorksService } from '../works/works-service.js';
import { createWakeService } from './wake-service.js';

/**
 * Будильник и `rooms.mail` (карта-журнал, задача 9): письмо в журнал пересчитывает только адресатов. Работы здесь —
 * заглушка с настоящей картой на диске, а `recompute` считает счётчик окна (он увеличивается на каждый пересчёт сессии).
 */
let home = '';
let project = '';
let previous: string | undefined;
beforeEach(async () => {
  home = await mkdtemp('/private/tmp/parley-mail-wake-');
  previous = process.env['PARLEY_HOME'];
  process.env['PARLEY_HOME'] = home;
  project = path.join(home, 'project');
});
afterEach(async () => {
  if (previous === undefined) delete process.env['PARLEY_HOME'];
  else process.env['PARLEY_HOME'] = previous;
  await rm(home, { recursive: true, force: true });
});

/** Работа с тремя закрытыми сессиями и комнатой из них троих: закрытая сессия пересчитывается, но ничего не запускает. */
async function prepare(): Promise<{ workId: string; roomId: string }> {
  const { work } = await createWork(project, { title: 'Почта' });
  let roomId = '';
  await updateMap(project, work.id, (map) => {
    for (const label of ['A', 'B', 'C']) addSession(map, { provider: 'claude', label, task: 'x' });
    for (const id of ['s-01', 's-02', 's-03']) {
      transitionSession(map, id, 'active');
      transitionSession(map, id, 'closed');
    }
    roomId = addRoom(map, { title: 'R', creator: HUMAN, members: ['s-01', 's-02', 's-03'], lead: 's-01' }).id;
  });
  return { workId: work.id, roomId };
}

async function rig(workId: string) {
  const map: WorkMap = await readMap(project, workId);
  let onMail: (mail: RoomMail) => void = () => {};
  let onChange: () => void = () => {};
  const works = {
    snapshot: () => ({ entries: [{ projectPath: project, map }], branches: {} }),
    entry: (projectPath: string, id: string) => (projectPath === project && id === workId ? { projectPath: project, map } : undefined),
    onChange: (fn: () => void) => {
      onChange = fn;
      return () => {};
    },
    onMail: (fn: (mail: RoomMail) => void) => {
      onMail = fn;
      return () => {};
    },
  } as unknown as WorksService;
  const activity = { onChange: () => () => {}, mailWaiting: vi.fn() } as unknown as ActivityService;
  const pty = { get: () => undefined, on: () => () => {} } as unknown as PtyManager;
  const host = { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, broadcast: vi.fn() } as unknown as HostContext;
  const recompute = vi.fn();
  const windowCounters = { recompute } as unknown as WindowCounters;
  const wake = createWakeService(host, works, activity, pty, { launch: vi.fn<SessionsService['launch']>(async () => {}) }, { windowCounters });
  wake.start();
  recompute.mockClear();
  return { recompute, mail: (mail: RoomMail) => onMail(mail), change: () => onChange() };
}

const letter = (id: string, from: string, to: string[]) => ({ id, from, to, kind: 'note', at: '2026-10-16T10:00:00.000Z' });

describe('будильник и rooms.mail', () => {
  it('письмо в комнату из трёх пересчитывает ровно двух адресатов, не отправителя', async () => {
    const { workId, roomId } = await prepare();
    const { recompute, mail } = await rig(workId);
    mail({ projectPath: project, workId, roomId, appended: [letter('m-01', 's-01', [])] });
    expect(recompute).toHaveBeenCalledTimes(2);
  });

  it('прямое письмо одной сессии пересчитывает одну, а письмо человеку — ни одной', async () => {
    const { workId } = await prepare();
    const { recompute, mail } = await rig(workId);
    mail({ projectPath: project, workId, roomId: null, appended: [letter('m-01', 's-01', ['s-02'])] });
    expect(recompute).toHaveBeenCalledTimes(1);
    recompute.mockClear();
    mail({ projectPath: project, workId, roomId: null, appended: [letter('m-02', 's-01', [HUMAN])] });
    expect(recompute).not.toHaveBeenCalled();
  });

  it('письмо в другую работу ничего не пересчитывает', async () => {
    const { workId, roomId } = await prepare();
    const { recompute, mail } = await rig(workId);
    mail({ projectPath: project, workId: 'w-other', roomId, appended: [letter('m-01', 's-01', [])] });
    expect(recompute).not.toHaveBeenCalled();
  });

  it('изменение индекса (works.onChange) по-прежнему пересчитывает все сессии', async () => {
    const { workId } = await prepare();
    const { recompute, change } = await rig(workId);
    change();
    expect(recompute).toHaveBeenCalledTimes(3);
  });
});
