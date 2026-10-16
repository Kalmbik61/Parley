import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MapCompact, Message, WorkEntry } from '@parley/core';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { makeLetter, makeRoom, makeWork } from '../test-utils/work-fixtures.js';
import { ROOMS_MAIL_FEATURE } from '@parley/protocol';
import { useHostStore } from './host.js';
import { useRoomPagesStore } from './room-pages.js';
import { useWorksStore } from './works.js';

const note = (id: string): Message => makeLetter(id, { roomId: 'r-01', to: [], from: 's-01', readBy: { human: 'x' } });

function entry(messages: Message[], total: number, tailFrom: number | null): WorkEntry {
  const base = makeWork('w-01', { rooms: [makeRoom('r-01', 'К')], messages });
  const compact: MapCompact = {
    version: 1,
    messages: { total, included: messages.length, latestId: `m-${total}`, rooms: { 'r-01': { total, included: messages.length, tailFrom } } },
    unread: { letters: 0, rooms: {} },
    cut: [],
    omitted: {},
  };
  return { ...base, map: { ...base.map, compact } };
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

describe('useRoomPagesStore.init: rooms.mail', () => {
  const connected = (features: string[] | null): void =>
    useHostStore.setState({ status: { state: 'connected', hostVersion: '0.14.0', methods: null, features } });
  const mail = (roomId: string | null = 'r-01') => ({ projectPath: '/tmp/proj', workId: 'w-01', roomId, appended: [{ id: 'm-10', from: 's-01', to: [], kind: 'note', at: 'x' }] });
  const page = (messages: Message[]) => ({ messages, page: { total: 10, returned: messages.length, complete: true, next: null, bytes: 1, cut: 0 } });

  it('письмо комнаты дочитывается хвостом после последнего известного номера и встаёт в карту без works.changed', async () => {
    connected([ROOMS_MAIL_FEATURE]);
    const bridge = createFakeBridge();
    const cursors: Array<string | undefined> = [];
    bridge.setHandler('context.messages', (params) => {
      cursors.push(params.cursor);
      return page([note('m-10')]);
    });
    useWorksStore.setState({ entries: [entry([note('m-08'), note('m-09')], 9, 8)] });
    const off = useRoomPagesStore.getState().init(bridge);

    bridge.emit('rooms.mail', mail());
    await vi.waitFor(() => expect(useWorksStore.getState().entries[0]?.map.messages.map((message) => message.id)).toEqual(['m-08', 'm-09', 'm-10']));

    expect(cursors).toEqual(['after:9']);
    // счётчики хоста растут вместе с лентой: «ещё старых» не появляется от нового письма
    const compact = useWorksStore.getState().entries[0]!.map.compact!;
    expect(compact.messages.total).toBe(10);
    expect(compact.messages.rooms['r-01']).toMatchObject({ total: 10, included: 3 });
    expect(compact.messages.latestId).toBe('m-10');
    off();
  });

  it('то же письмо дважды (событие и страница) не дублируется и не раздувает счётчики', async () => {
    connected([ROOMS_MAIL_FEATURE]);
    const bridge = createFakeBridge();
    bridge.setHandler('context.messages', () => page([note('m-09'), note('m-10')]));
    useWorksStore.setState({ entries: [entry([note('m-08'), note('m-09')], 9, 8)] });
    const off = useRoomPagesStore.getState().init(bridge);
    bridge.emit('rooms.mail', mail());
    await vi.waitFor(() => expect(useWorksStore.getState().entries[0]?.map.messages).toHaveLength(3));
    expect(useWorksStore.getState().entries[0]?.map.compact?.messages.total).toBe(10);
    off();
  });

  it('прежний хост без признака rooms-mail: событие не читается, окно живёт по works.changed как раньше', async () => {
    connected(null);
    const bridge = createFakeBridge();
    let calls = 0;
    bridge.setHandler('context.messages', () => {
      calls += 1;
      return page([note('m-10')]);
    });
    useWorksStore.setState({ entries: [entry([note('m-09')], 9, 9)] });
    const off = useRoomPagesStore.getState().init(bridge);
    bridge.emit('rooms.mail', mail());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toBe(0);
    expect(useWorksStore.getState().entries[0]?.map.messages.map((message) => message.id)).toEqual(['m-09']);
    off();
  });

  it('письмо работы, которой в окне нет, ничего не запрашивает', async () => {
    connected([ROOMS_MAIL_FEATURE]);
    const bridge = createFakeBridge();
    let calls = 0;
    bridge.setHandler('context.messages', () => {
      calls += 1;
      return page([]);
    });
    useWorksStore.setState({ entries: [] });
    const off = useRoomPagesStore.getState().init(bridge);
    bridge.emit('rooms.mail', mail());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toBe(0);
    off();
  });
});
