import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addMessage, addSession } from './map.js';
import { migrateMapToJournal } from './migrate-map.js';
import { addRoom } from './rooms.js';
import { createWork, readMap, readMapOnBase, updateMap, workPaths } from './store.js';
import { HUMAN } from './types.js';

/** `readMapOnBase`: индекс карты-журнала поверх уже собранной карты, журналы писем не читаются. */
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

describe('readMapOnBase', () => {
  it('берёт сессии из свежего индекса, а письма из собранной карты, не читая журналов (нечитаемый журнал не мешает)', async () => {
    const { work } = await createWork(project, { title: 'W' });
    await updateMap(project, work.id, (map) => {
      const session = addSession(map, { provider: 'claude', label: 'a', task: 't' });
      const room = addRoom(map, { title: 'К', creator: HUMAN, members: [session.id], lead: session.id });
      addMessage(map, { roomId: room.id, from: HUMAN, to: [session.id], text: 'письмо' });
    });
    expect(await migrateMapToJournal(project, work.id)).toMatchObject({ status: 'migrated' });
    const base = await readMap(project, work.id);
    await updateMap(project, work.id, (map) => {
      map.sessions[0]!.label = 'новая метка';
    });
    // Журнал комнаты подменён каталогом: `readMap` теперь упал бы.
    const journal = path.join(workPaths(project, work.id).rooms, 'r-01', 'messages.jsonl');
    await rm(journal, { force: true });
    await mkdir(journal, { recursive: true });
    await expect(readMap(project, work.id)).rejects.toThrow();

    const fresh = await readMapOnBase(project, work.id, base);

    expect(fresh.sessions[0]?.label).toBe('новая метка');
    expect(fresh.messages.map((message) => message.text)).toEqual(['письмо']);
  });

  it('карта v2 читается целиком, base ей не нужна', async () => {
    const { work } = await createWork(project, { title: 'W' });
    await updateMap(project, work.id, (map) => {
      addMessage(map, { roomId: null, from: HUMAN, to: [], text: 'прямое' });
    });
    const base = await readMap(project, work.id);
    await updateMap(project, work.id, (map) => {
      addMessage(map, { roomId: null, from: HUMAN, to: [], text: 'второе' });
    });

    const fresh = await readMapOnBase(project, work.id, base);

    expect(fresh.messages.map((message) => message.text)).toEqual(['прямое', 'второе']);
  });
});
