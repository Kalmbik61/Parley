import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MapCompact, Message, WindowWorkEntry } from '@parley/core';
import { ROOMS_MAIL_FEATURE } from '@parley/protocol';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { makeLetter, makeMailEvent, makeMailRoom, makeRoom, makeWork } from '../test-utils/work-fixtures.js';
import { MAIL_PAGES_MAX, followRoom, repairWork, useRoomPagesStore } from './room-pages.js';
import { useWorksStore } from './works.js';

const note = (id: string): Message => makeLetter(id, { roomId: 'r-01', to: [], from: 's-01', readBy: { human: 'x' } });

function entry(messages: Message[], total: number, tailFrom: number | null, version?: number): WindowWorkEntry {
  const base = makeWork('w-01', { rooms: [makeRoom('r-01', 'К')], messages });
  const compact: MapCompact = {
    version: 1,
    messages: { total, included: messages.length, latestId: `m-${total}`, rooms: { 'r-01': { total, included: messages.length, tailFrom } } },
    unread: { letters: 0, rooms: {} },
    cut: [],
    omitted: {},
  };
  return { ...base, map: { ...base.map, compact }, ...(version === undefined ? {} : { version }) };
}

beforeEach(() => {
  useRoomPagesStore.setState({ chains: {}, loading: {} });
  useWorksStore.setState({ entries: [], branches: {}, loading: false, error: null });
});

describe('useRoomPagesStore.loadEarlier', () => {
  it('идёт цепочкой: первый запрос — перед хвостом, следующие — по next; последняя страница закрывает цепочку', async () => {
    const bridge = createFakeBridge();
    const calls: Array<{ roomId: string | null; cursor?: string }> = [];
    const pages = [
      { messages: [note('m-06'), note('m-07')], page: { total: 9, returned: 2, complete: false, next: 'before:6', bytes: 1, cut: 0 } },
      { messages: [note('m-04'), note('m-05')], page: { total: 9, returned: 2, complete: true, next: null, bytes: 1, cut: 0 } },
    ];
    bridge.setHandler('context.messages', (params) => {
      calls.push({ roomId: params.roomId, ...(params.cursor === undefined ? {} : { cursor: params.cursor }) });
      return pages.shift()!;
    });
    const current = entry([note('m-08'), note('m-09')], 9, 8);
    useWorksStore.setState({ entries: [current] });
    const applied: string[][] = [];
    const apply = (messages: Message[]): void => {
      applied.push(messages.map((message) => message.id));
      useWorksStore.getState().addMessages('/tmp/proj', 'w-01', messages);
    };

    await useRoomPagesStore.getState().loadEarlier(bridge, current, 'r-01', apply);
    await useRoomPagesStore.getState().loadEarlier(bridge, useWorksStore.getState().entries[0]!, 'r-01', apply);

    expect(calls).toEqual([
      { roomId: 'r-01', cursor: 'before:8' },
      { roomId: 'r-01', cursor: 'before:6' },
    ]);
    expect(applied).toEqual([['m-06', 'm-07'], ['m-04', 'm-05']]);
    expect(useWorksStore.getState().entries[0]?.map.messages.map((message) => message.id)).toEqual(['m-04', 'm-05', 'm-06', 'm-07', 'm-08', 'm-09']);
    expect(Object.values(useRoomPagesStore.getState().chains)[0]).toEqual({ next: null, done: true });
  });

  it('цепочка дочитана, а окно всё ещё не держит всех писем (дыра) — следующий запрос снова с курсора перед хвостом', async () => {
    const bridge = createFakeBridge();
    const cursors: Array<string | undefined> = [];
    bridge.setHandler('context.messages', (params) => {
      cursors.push(params.cursor);
      return { messages: [], page: { total: 9, returned: 0, complete: true, next: null, bytes: 0, cut: 0 } };
    });
    const current = entry([note('m-08')], 9, 8);
    await useRoomPagesStore.getState().loadEarlier(bridge, current, 'r-01', () => {});
    await useRoomPagesStore.getState().loadEarlier(bridge, current, 'r-01', () => {});
    expect(cursors).toEqual(['before:8', 'before:8']);
  });

  it('второй запрос, пока идёт первый, не отправляется; ошибка хоста уходит вызывающему, цепочка не двигается', async () => {
    const bridge = createFakeBridge();
    let release: () => void = () => {};
    let calls = 0;
    bridge.setHandler('context.messages', () => {
      calls += 1;
      return new Promise((_resolve, reject) => (release = () => reject({ code: 'internal', message: 'нет' })));
    });
    const current = entry([note('m-08')], 9, 8);
    const first = useRoomPagesStore.getState().loadEarlier(bridge, current, 'r-01', () => {});
    await useRoomPagesStore.getState().loadEarlier(bridge, current, 'r-01', () => {});
    expect(calls).toBe(1);
    release();
    await expect(first).rejects.toBeDefined();
    expect(Object.values(useRoomPagesStore.getState().loading)[0]).toBe(false);
    expect(useRoomPagesStore.getState().chains).toEqual({});
  });

  it('хвоста нет (самое новое письмо за бюджетом) — первый запрос без курсора', async () => {
    const bridge = createFakeBridge();
    const seen: unknown[] = [];
    bridge.setHandler('context.messages', (params) => {
      seen.push(params);
      return { messages: [], page: { total: 0, returned: 0, complete: true, next: null, bytes: 0, cut: 0 } };
    });
    await useRoomPagesStore.getState().loadEarlier(bridge, entry([], 9, null), 'r-01', () => {});
    expect(seen).toEqual([{ projectPath: '/tmp/proj', workId: 'w-01', roomId: 'r-01' }]);
  });
});

describe('rooms.mail: письма события и дочитывание', () => {
  const unread = (id: string, patch: Partial<Message> = {}): Message => makeLetter(id, { roomId: 'r-01', to: [], from: 's-02', readBy: {}, ...patch });
  const pageOf = (messages: Message[], next: string | null = null) => ({
    messages,
    page: { total: 10, returned: messages.length, complete: next === null, next, bytes: 1, cut: 0 },
  });
  const ids = (): string[] => useWorksStore.getState().entries[0]!.map.messages.map((message) => message.id);
  const pageCalls = (bridge: ReturnType<typeof createFakeBridge>): unknown[] => bridge.calls.filter((call) => call.method === 'context.messages');

  /** Окно с работой в снимке, подключённое к хосту с признаком `rooms-mail` (или без: `features: null`). */
  async function open(current: WindowWorkEntry | null, features: string[] | null = [ROOMS_MAIL_FEATURE]) {
    const bridge = createFakeBridge();
    bridge.emitStatus({ state: 'connected', hostVersion: '0.0.0-test', methods: null, features });
    bridge.setHandler('works.list', () => ({ entries: current === null ? [] : [current], branches: {}, revision: 1 }));
    const dispose = useWorksStore.getState().init(bridge);
    await vi.waitFor(() => expect(useWorksStore.getState().loading).toBe(false));
    return { bridge, dispose };
  }

  it('письмо комнаты приходит событием целиком: встаёт в карту без запросов и без works.changed, число писем растёт вместе с лентой', async () => {
    const { bridge, dispose } = await open(entry([note('m-08'), note('m-09')], 9, 8, 5));
    bridge.emit(
      'rooms.mail',
      makeMailEvent({ version: 6, prevVersion: 5, rooms: [makeMailRoom('r-01', { prevTop: 9, top: 10, total: 10, letters: [note('m-10')] })] }),
    );
    expect(ids()).toEqual(['m-08', 'm-09', 'm-10']);
    expect(pageCalls(bridge)).toEqual([]);
    // счётчики хоста растут вместе с лентой: «ещё старых» не появляется от нового письма
    const compact = useWorksStore.getState().entries[0]!.map.compact!;
    expect(compact.messages.total).toBe(10);
    expect(compact.messages.rooms['r-01']).toMatchObject({ total: 10, included: 3 });
    expect(compact.messages.latestId).toBe('m-10');
    dispose();
  });

  it('то же письмо дважды (событие и страница дочитывания) не дублируется и не раздувает счётчики', async () => {
    const { bridge, dispose } = await open(entry([note('m-08'), note('m-09')], 9, 8, 5));
    bridge.setHandler('context.messages', () => pageOf([note('m-09'), note('m-10')]));
    bridge.emit(
      'rooms.mail',
      makeMailEvent({ version: 6, prevVersion: 5, rooms: [makeMailRoom('r-01', { prevTop: 9, top: 10, total: 10, letters: [note('m-10')] })] }),
    );
    await followRoom(bridge, useWorksStore.getState().entries[0]!, 'r-01');
    expect(ids()).toEqual(['m-08', 'm-09', 'm-10']);
    expect(useWorksStore.getState().entries[0]?.map.compact?.messages.total).toBe(10);
    expect(useWorksStore.getState().entries[0]?.map.compact?.messages.rooms['r-01']).toMatchObject({ total: 10, included: 3 });
    dispose();
  });

  it('прежний хост без признака rooms-mail: событие не читается, окно живёт по works.changed как раньше', async () => {
    const { bridge, dispose } = await open(entry([note('m-09')], 9, 9, 5), null);
    bridge.setHandler('context.messages', () => pageOf([note('m-10')]));
    bridge.emit(
      'rooms.mail',
      makeMailEvent({ version: 8, prevVersion: 6, rooms: [makeMailRoom('r-01', { prevTop: 9, top: 10, total: 10, letters: [note('m-10')] })] }),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(pageCalls(bridge)).toEqual([]);
    expect(ids()).toEqual(['m-09']);
    dispose();
  });

  it('письмо работы, которой в окне нет, ничего не запрашивает', async () => {
    const { bridge, dispose } = await open(null);
    bridge.setHandler('context.messages', () => pageOf([]));
    bridge.emit('rooms.mail', makeMailEvent({ version: 6, prevVersion: 5, rooms: [makeMailRoom('r-01', { prevTop: 9, top: 10, total: 10, letters: [note('m-10')] })] }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(pageCalls(bridge)).toEqual([]);
    expect(useWorksStore.getState().entries).toEqual([]);
    dispose();
  });

  describe('followRoom', () => {
    it('читает страницы после наибольшего держимого номера цепочкой по next и встаёт в карту свежими копиями', async () => {
      const bridge = createFakeBridge();
      const cursors: Array<string | undefined> = [];
      const answers = [pageOf([unread('m-10')], 'after:10'), pageOf([unread('m-11')])];
      bridge.setHandler('context.messages', (params) => {
        cursors.push(params.cursor);
        return answers.shift()!;
      });
      const current = entry([note('m-08'), note('m-09')], 9, 8, 5);
      useWorksStore.setState({ entries: [current] });
      await followRoom(bridge, current, 'r-01');
      expect(cursors).toEqual(['after:9', 'after:10']);
      expect(ids()).toEqual(['m-08', 'm-09', 'm-10', 'm-11']);
    });

    it('страниц не больше потолка: остальное добирает следующий снимок', async () => {
      const bridge = createFakeBridge();
      let calls = 0;
      bridge.setHandler('context.messages', () => {
        calls += 1;
        return pageOf([], `after:${10 + calls}`);
      });
      const current = entry([note('m-09')], 9, 9, 5);
      useWorksStore.setState({ entries: [current] });
      await followRoom(bridge, current, 'r-01');
      expect(calls).toBe(MAIL_PAGES_MAX);
    });

    it('комнату без держимых писем не читает', async () => {
      const bridge = createFakeBridge();
      bridge.setHandler('context.messages', () => pageOf([]));
      await followRoom(bridge, entry([], 9, null, 5), 'r-01');
      expect(pageCalls(bridge)).toEqual([]);
    });
  });

  describe('repairWork', () => {
    it('каждая держимая комната и Mail читаются от наименьшего держимого номера до вершины', async () => {
      const bridge = createFakeBridge();
      const asked: Array<[string | null, string | undefined]> = [];
      const answers: Record<string, Array<ReturnType<typeof pageOf>>> = {
        'r-01': [pageOf([unread('m-08', { readBy: { human: 'T' } }), unread('m-09')], 'after:9'), pageOf([unread('m-10')])],
        direct: [pageOf([unread('m-04', { roomId: null, to: ['human'], readBy: { human: 'T' } })])],
      };
      bridge.setHandler('context.messages', (params) => {
        asked.push([params.roomId, params.cursor]);
        return answers[params.roomId ?? 'direct']!.shift()!;
      });
      const current = entry([unread('m-08'), unread('m-09'), unread('m-04', { roomId: null, to: ['human'] })], 9, 8, 5);
      useWorksStore.setState({ entries: [current] });
      await repairWork(bridge, current);
      expect(asked).toEqual([
        ['r-01', 'after:7'],
        ['r-01', 'after:9'],
        [null, 'after:3'],
      ]);
      const held = useWorksStore.getState().entries[0]!.map.messages;
      expect(held.map((message) => message.id)).toEqual(['m-04', 'm-08', 'm-09', 'm-10']);
      expect(held.find((message) => message.id === 'm-08')?.readBy).toEqual({ human: 'T' });
      expect(held.find((message) => message.id === 'm-04')?.readBy).toEqual({ human: 'T' });
    });

    it('сбой одной комнаты не мешает остальным; вызывающий узнаёт о нём; not_found не сбой', async () => {
      const bridge = createFakeBridge();
      bridge.setHandler('context.messages', (params) => {
        if (params.roomId === 'r-01') throw { code: 'internal', message: 'нет' };
        if (params.roomId === 'r-02') throw { code: 'not_found', message: 'room r-02 does not exist' };
        return pageOf([unread('m-04', { roomId: null, to: ['human'], readBy: { human: 'T' } })]);
      });
      const current = entry([unread('m-08'), unread('m-05', { roomId: 'r-02' }), unread('m-04', { roomId: null, to: ['human'] })], 9, 8, 5);
      useWorksStore.setState({ entries: [current] });
      await expect(repairWork(bridge, current)).rejects.toMatchObject({ code: 'internal' });
      expect(useWorksStore.getState().entries[0]!.map.messages.find((message) => message.id === 'm-04')?.readBy).toEqual({ human: 'T' });
      await expect(repairWork(bridge, entry([unread('m-05', { roomId: 'r-02' })], 9, 8, 5))).resolves.toBeUndefined();
    });
  });
});
