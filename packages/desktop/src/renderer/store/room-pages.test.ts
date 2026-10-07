import { beforeEach, describe, expect, it } from 'vitest';
import type { MapCompact, Message, WorkEntry } from '@parley/core';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { makeLetter, makeRoom, makeWork } from '../test-utils/work-fixtures.js';
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
