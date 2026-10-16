import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HUMAN, addMessage, addRoom, addSession, createWork, migrateMapToJournal, updateMap, workPaths } from '@parley/core';
import { requireWork } from './works.js';

/**
 * Ворота существования работы перед методами окна не читают журналы писем: на карте-журнале хватает индекса.
 * Журнал комнаты подменён каталогом — чтение его писем упало бы, а ворота обязаны пройти.
 */
let home = '';
let project = '';

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
  process.env.PARLEY_HOME = home;
});

afterEach(async () => {
  delete process.env.PARLEY_HOME;
  await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Работа на журналах (v3) с комнатой, у которой нечитаемый журнал писем. */
async function seedUnreadableJournal(): Promise<string> {
  const { work } = await createWork(project, { title: 'W' });
  await updateMap(project, work.id, (map) => {
    const session = addSession(map, { provider: 'claude', label: 'a', task: 't' });
    const room = addRoom(map, { title: 'Комната', creator: HUMAN, members: [session.id], lead: session.id });
    addMessage(map, { roomId: room.id, from: HUMAN, to: [session.id], text: 'письмо' });
  });
  expect(await migrateMapToJournal(project, work.id)).toMatchObject({ status: 'migrated' });
  const paths = workPaths(project, work.id);
  const roomDir = path.join(paths.rooms, 'r-01');
  await rm(path.join(roomDir, 'messages.jsonl'), { force: true });
  await mkdir(path.join(roomDir, 'messages.jsonl'), { recursive: true });
  return work.id;
}

describe('requireWork на карте-журнале', () => {
  it('проходит, не читая журналы писем: нечитаемый журнал комнаты ему не помеха', async () => {
    const workId = await seedUnreadableJournal();

    await expect(requireWork(project, workId)).resolves.toBeUndefined();
  });

  it('несуществующая работа по-прежнему not_found', async () => {
    await expect(requireWork(project, 'w-9999')).rejects.toMatchObject({ code: 'not_found' });
  });
});
