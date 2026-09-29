import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isUnreadFor, markHumanRead, recipientsOf, unreadFor } from './letters.js';
import { addMessage } from './map.js';
import { createWork, readMap, updateMap, WorkNotFoundError, workPaths } from './store.js';
import { HUMAN, type WorkMap } from './types.js';

/** Работа с комнатой r-01: создатель s-01, участники s-02 и s-03; s-04 вне её. */
const mapWithRoom = (): WorkMap => ({
  schemaVersion: 2,
  work: {
    id: 'w-0001',
    title: 'комнаты',
    goal: '',
    status: 'active',
    createdAt: '2026-09-26T10:00:00.000Z',
    updatedAt: '2026-09-26T10:00:00.000Z',
  },
  sessions: [],
  messages: [],
  rooms: [
    {
      id: 'r-01',
      title: 'бэкенд',
      creator: 's-01',
      members: ['s-02', 's-03'],
      createdAt: '2026-09-26T10:00:00.000Z',
      lead: null,
      proposal: null,
    },
  ],
});

describe('recipientsOf', () => {
  it('прямое письмо — адресаты из to', () => {
    const map = mapWithRoom();
    const letter = addMessage(map, { from: 's-01', to: ['s-04'], text: 'x' });

    expect(recipientsOf(letter, map)).toEqual(['s-04']);
  });

  it('адресное письмо в комнате — только адресаты', () => {
    const map = mapWithRoom();
    const letter = addMessage(map, { from: 's-02', to: ['s-03'], text: 'x', roomId: 'r-01' });

    expect(recipientsOf(letter, map)).toEqual(['s-03']);
  });

  it('рассылка комнаты — все участники без отправителя, создатель тоже участник', () => {
    const map = mapWithRoom();
    const letter = addMessage(map, { from: 's-02', to: [], text: 'x', roomId: 'r-01' });

    expect(recipientsOf(letter, map).sort()).toEqual(['s-01', 's-03']);
  });

  it('рассылка человека — всем участникам', () => {
    const map = mapWithRoom();
    const letter = addMessage(map, { from: HUMAN, to: [], text: 'x', roomId: 'r-01' });

    expect(recipientsOf(letter, map).sort()).toEqual(['s-01', 's-02', 's-03']);
  });

  it('комнаты нет в карте — адресатов у рассылки нет', () => {
    const map = mapWithRoom();
    const letter = addMessage(map, { from: 's-02', to: [], text: 'x', roomId: 'r-09' });

    expect(recipientsOf(letter, map)).toEqual([]);
  });
});

describe('unreadFor', () => {
  it('прочтение отмечается по адресату, а не по письму', () => {
    const map = mapWithRoom();
    const broadcast = addMessage(map, { from: 's-01', to: [], text: 'всем', roomId: 'r-01' });
    broadcast.readBy['s-02'] = '2026-09-26T10:05:00.000Z';

    expect(isUnreadFor(broadcast, 's-02', map)).toBe(false);
    expect(isUnreadFor(broadcast, 's-03', map)).toBe(true);
    expect(unreadFor(map, 's-02')).toEqual([]);
    expect(unreadFor(map, 's-03')).toEqual([broadcast]);
  });

  it('письмо не адресату непрочитанным у него не числится', () => {
    const map = mapWithRoom();
    addMessage(map, { from: 's-02', to: ['s-03'], text: 'лично', roomId: 'r-01' });
    const direct = addMessage(map, { from: 's-01', to: ['s-04'], text: 'x' });

    expect(unreadFor(map, 's-01')).toEqual([]);
    expect(unreadFor(map, 's-04')).toEqual([direct]);
    // Отправитель своё письмо не «читает».
    expect(unreadFor(map, 's-02')).toEqual([]);
  });
});

describe('markHumanRead', () => {
  let home = '';
  let project = '';
  const OLD = '2020-01-01T00:00:00.000Z';

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'harnas-home-'));
    project = await mkdtemp(path.join(tmpdir(), 'harnas-project-'));
    process.env.HARNAS_HOME = home;
  });

  afterEach(async () => {
    delete process.env.HARNAS_HOME;
    await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
  });

  /**
   * Таблица «непрочитано человеком» — та же, что у теста 7 куска 4.2 (окно считает
   * сам: рантайм core ему недоступен). Комната r-01: s-01 создатель, s-02 участник.
   * updatedAt состарен, чтобы увидеть, что отметка его не сдвигает.
   */
  async function seed(): Promise<void> {
    await createWork(project, { title: 'почта' });
    await updateMap(project, 'w-0001', (map) => {
      map.rooms.push({
        id: 'r-01',
        title: 'r',
        creator: 's-01',
        members: ['s-02'],
        createdAt: OLD,
        lead: null,
        proposal: null,
      });
      addMessage(map, { from: 's-01', to: [HUMAN], text: 'человеку' }); // m-01
      const both = addMessage(map, { from: 's-01', to: [HUMAN, 's-02'], text: 'обоим' }); // m-02
      both.readBy['s-02'] = OLD;
      addMessage(map, { from: 's-01', to: ['s-02'], text: 'агенту' }); // m-03
      addMessage(map, { from: 's-02', to: [], text: 'в комнату', roomId: 'r-01' }); // m-04
      addMessage(map, { from: HUMAN, to: [], text: 'от человека', roomId: 'r-01' }); // m-05
      addMessage(map, { from: HUMAN, to: ['s-01'], text: 'агенту от человека' }); // m-06
    });
    const file = workPaths(project, 'w-0001').map;
    const raw = JSON.parse(await readFile(file, 'utf8')) as WorkMap;
    raw.work.updatedAt = OLD;
    await writeFile(file, JSON.stringify(raw), 'utf8');
  }

  const readAt = async (id: string): Promise<string | undefined> =>
    (await readMap(project, 'w-0001')).messages.find((m) => m.id === id)?.readBy[HUMAN];

  it('письмо S01 человеку → 1, readBy.human — ISO-время', async () => {
    await seed();

    expect(await markHumanRead(project, 'w-0001', ['m-01'])).toBe(1);
    const at = await readAt('m-01');
    expect(at).toBeDefined();
    expect(new Date(at as string).toISOString()).toBe(at);
  });

  it('повтор → 0, map.json не переписан', async () => {
    await seed();
    await markHumanRead(project, 'w-0001', ['m-01']);
    const file = workPaths(project, 'w-0001').map;
    const before = (await stat(file)).mtimeMs;
    const text = await readFile(file, 'utf8');

    expect(await markHumanRead(project, 'w-0001', ['m-01'])).toBe(0);
    expect((await stat(file)).mtimeMs).toBe(before);
    expect(await readFile(file, 'utf8')).toBe(text);
  });

  it('письмо человеку и S02, прочитанное S02, но не человеком → 1', async () => {
    await seed();

    expect(await markHumanRead(project, 'w-0001', ['m-02'])).toBe(1);
    expect(await readAt('m-02')).toBeDefined();
  });

  it('письмо S01 агенту S02 → 0', async () => {
    await seed();

    expect(await markHumanRead(project, 'w-0001', ['m-03'])).toBe(0);
    expect(await readAt('m-03')).toBeUndefined();
  });

  it('сообщение комнаты от S02 → 1; от человека → 0', async () => {
    await seed();

    expect(await markHumanRead(project, 'w-0001', ['m-04'])).toBe(1);
    expect(await markHumanRead(project, 'w-0001', ['m-05'])).toBe(0);
    expect(await readAt('m-05')).toBeUndefined();
  });

  it('письмо человека агенту S01 → 0', async () => {
    await seed();

    expect(await markHumanRead(project, 'w-0001', ['m-06'])).toBe(0);
  });

  it('неизвестный id → 0; пачка считает только подходящие', async () => {
    await seed();

    expect(await markHumanRead(project, 'w-0001', ['m-99'])).toBe(0);
    expect(
      await markHumanRead(project, 'w-0001', ['m-01', 'm-02', 'm-03', 'm-04', 'm-05', 'm-06', 'm-99']),
    ).toBe(3);
  });

  it('work.updatedAt после отметок прежний — порядок сайдбара не меняется', async () => {
    await seed();
    await markHumanRead(project, 'w-0001', ['m-01', 'm-04']);

    expect((await readMap(project, 'w-0001')).work.updatedAt).toBe(OLD);
  });

  it('работы нет — WorkNotFoundError', async () => {
    await expect(markHumanRead(project, 'w-0009', ['m-01'])).rejects.toBeInstanceOf(WorkNotFoundError);
  });
});
