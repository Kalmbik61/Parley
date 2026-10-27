import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addRoom, addSession, createWork, HUMAN, readStoredMap, transitionSession, updateMap } from '@parley/core';
import type { LetterJournal, Message } from '@parley/core';
import type { ActivityService } from '../activity/activity-service.js';
import type { HostContext } from '../context.js';
import type { WindowCounters } from '../health/window-counters.js';
import type { PtyManager } from '../pty/pty-manager.js';
import type { SessionsService } from '../sessions/sessions-service.js';
import type { MailNotice, WorksService } from '../works/works-service.js';
import { createWakeService } from './wake-service.js';

/**
 * Будильник и `onMail` (спека rooms.mail 6.7): запись писем пересчитывает только адресатов и читателей. Работа — заглушка
 * с настоящей картой на диске, а `recompute` считает счётчик окна: он растёт на каждый пересчёт сессии.
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
  const map = readStoredMap(project, workId);
  let onMail: (notice: MailNotice) => void = () => {};
  let onChange: () => void = () => {};
  const works = {
    snapshot: () => ({ entries: [{ projectPath: project, map }], branches: {} }),
    entry: (projectPath: string, id: string) => (projectPath === project && id === workId ? { projectPath: project, map } : undefined),
    onChange: (fn: () => void) => {
      onChange = fn;
      return () => {};
    },
    onMail: (fn: (notice: MailNotice) => void) => {
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
  return { recompute, mail: (notice: MailNotice) => onMail(notice), change: () => onChange() };
}

const AT = '2026-10-27T10:00:00.000Z';
const letter = (id: string, from: string, to: string[], roomId: string | null = null): Message =>
  ({ id, roomId, from, to, at: AT, text: 'x', kind: 'note', readBy: {} }) as Message;
const noticeOf = (workId: string, journal: Partial<LetterJournal>): MailNotice => ({
  projectPath: project,
  workId,
  version: 2,
  prevVersion: 1,
  journal: { added: [], reads: [], deleted: [], droppedRooms: [], rereadRooms: [], ...journal },
  foreign: false,
});

describe('будильник и onMail', () => {
  it('письмо в комнату из трёх пересчитывает ровно двух адресатов, не отправителя', async () => {
    const { workId, roomId } = await prepare();
    const { recompute, mail } = await rig(workId);
    mail(noticeOf(workId, { added: [letter('m-01', 's-01', [], roomId)] }));
    expect(recompute).toHaveBeenCalledTimes(2);
  });

  it('прямое письмо одной сессии пересчитывает одну, а письмо человеку — ни одной', async () => {
    const { workId } = await prepare();
    const { recompute, mail } = await rig(workId);
    mail(noticeOf(workId, { added: [letter('m-01', 's-01', ['s-02'])] }));
    expect(recompute).toHaveBeenCalledTimes(1);
    recompute.mockClear();
    mail(noticeOf(workId, { added: [letter('m-02', 's-01', [HUMAN])] }));
    expect(recompute).not.toHaveBeenCalled();
  });

  it('отметка прочтения пересчитывает читателя', async () => {
    const { workId } = await prepare();
    const { recompute, mail } = await rig(workId);
    mail(noticeOf(workId, { reads: [{ id: 'm-01', reader: 's-02', at: AT }] }));
    expect(recompute).toHaveBeenCalledTimes(1);
  });

  it('письмо в другую работу ничего не пересчитывает', async () => {
    const { workId, roomId } = await prepare();
    const { recompute, mail } = await rig(workId);
    mail({ ...noticeOf(workId, { added: [letter('m-01', 's-01', [], roomId)] }), workId: 'w-other' });
    expect(recompute).not.toHaveBeenCalled();
  });

  it('onChange по-прежнему пересчитывает все сессии', async () => {
    const { workId } = await prepare();
    const { recompute, change } = await rig(workId);
    change();
    expect(recompute).toHaveBeenCalledTimes(3);
  });
});
