import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MapCompact, Message, WindowWorkEntry } from '@parley/core';
import { ROOMS_MAIL_FEATURE } from '@parley/protocol';
import { makeCompactMail, makeRoomNumbers, withCompactMail } from '../test-utils/compact-mail-fixtures.js';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { makeLetter, makeMailEvent, makeMailRoom, makeRoom, makeWork } from '../test-utils/work-fixtures.js';
import { MAIL_PAGES_MAX, followRoom, heldPolicy, openMail, openRoom, repairWork, rereadRoom, stopOpenRetries, useRoomPagesStore } from './room-pages.js';
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
  stopOpenRetries();
  useRoomPagesStore.setState({ chains: {}, loading: {}, opened: {}, quotes: {} });
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
  /** Компактная карта версии 1 (хвосты писем) первой работы стора. */
  const v1 = (): MapCompact => useWorksStore.getState().entries[0]!.map.compact as MapCompact;
  const pageCalls = (bridge: ReturnType<typeof createFakeBridge>): unknown[] => bridge.calls.filter((call) => call.method === 'context.messages');
  /** Хост листает комнату `r-01` от вершины вниз по сотне писем (номера 1..top): без курсора — вершина, `before:N` — старше номера N. */
  const hostPaging =
    (top: number, cursors: Array<string | undefined>) =>
    (params: { cursor?: string | undefined }) => {
      cursors.push(params.cursor);
      const below = params.cursor === undefined ? top + 1 : Number(params.cursor.slice('before:'.length));
      const from = Math.max(1, below - 100);
      const messages = Array.from({ length: below - from }, (_, index) => unread(`m-${from + index}`));
      return pageOf(messages, from === 1 ? null : `before:${from}`);
    };

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
    const compact = v1();
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
    expect(v1().messages.total).toBe(10);
    expect(v1().messages.rooms['r-01']).toMatchObject({ total: 10, included: 3 });
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
    it('читает от вершины вниз цепочкой по next до наибольшего держимого номера и встаёт в карту свежими копиями', async () => {
      const bridge = createFakeBridge();
      const cursors: Array<string | undefined> = [];
      // Вторая страница достигает m-09 (наибольший держимый): `next` у неё есть, но читать дальше не нужно.
      const answers = [pageOf([unread('m-11'), unread('m-12')], 'before:11'), pageOf([unread('m-09', { readBy: { human: 'T' } }), unread('m-10')], 'before:9')];
      bridge.setHandler('context.messages', (params) => {
        cursors.push(params.cursor);
        return answers.shift()!;
      });
      const current = entry([note('m-08'), note('m-09')], 9, 8, 5);
      useWorksStore.setState({ entries: [current] });
      await followRoom(bridge, current, 'r-01');
      expect(cursors).toEqual([undefined, 'before:11']);
      expect(ids()).toEqual(['m-08', 'm-09', 'm-10', 'm-11', 'm-12']);
    });

    it('не дошли до держимого за потолок страниц — сбой, а письма вершины всё равно встали в карту', async () => {
      const bridge = createFakeBridge();
      const cursors: Array<string | undefined> = [];
      const top = 100 * (MAIL_PAGES_MAX + 5);
      bridge.setHandler('context.messages', hostPaging(top, cursors));
      const current = entry([note('m-09')], 9, 9, 5);
      useWorksStore.setState({ entries: [current] });
      await expect(followRoom(bridge, current, 'r-01')).rejects.toThrow(/not read down to m-9 within/);
      expect(cursors).toHaveLength(MAIL_PAGES_MAX);
      expect(ids()).toContain(`m-${top}`);
    });

    it('комнату без держимых писем не читает', async () => {
      const bridge = createFakeBridge();
      bridge.setHandler('context.messages', () => pageOf([]));
      await followRoom(bridge, entry([], 9, null, 5), 'r-01');
      expect(pageCalls(bridge)).toEqual([]);
    });
  });

  describe('repairWork', () => {
    it('каждая держимая комната и Mail читаются от вершины вниз до наименьшего держимого номера', async () => {
      const bridge = createFakeBridge();
      const asked: Array<[string | null, string | undefined]> = [];
      // Вторая страница r-01 достигает m-08 (наименьший держимый): `next` у неё есть, но третьей страницы не будет.
      const answers: Record<string, Array<ReturnType<typeof pageOf>>> = {
        'r-01': [pageOf([unread('m-09'), unread('m-10')], 'before:9'), pageOf([unread('m-08', { readBy: { human: 'T' } })], 'before:8')],
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
        ['r-01', undefined],
        ['r-01', 'before:9'],
        [null, undefined],
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

    it('диапазон больше потолка страниц: письма вершины доходят, старый конец остаётся, а не дочитанное — сбой, не тихий возврат', async () => {
      const bridge = createFakeBridge();
      const cursors: Array<string | undefined> = [];
      const top = 100 * (MAIL_PAGES_MAX + 5);
      bridge.setHandler('context.messages', hostPaging(top, cursors));
      // Окно держит только два самых старых письма комнаты: диапазон от m-1 до вершины втрое длиннее потолка.
      const current = entry([unread('m-1'), unread('m-2')], top, 1, 5);
      useWorksStore.setState({ entries: [current] });
      await expect(repairWork(bridge, current)).rejects.toThrow(/not read down to m-1 within/);
      expect(cursors).toHaveLength(MAIL_PAGES_MAX);
      const lowest = top - 100 * MAIL_PAGES_MAX + 1;
      expect(ids()).toContain(`m-${top}`);
      expect(ids()).toContain(`m-${lowest}`);
      expect(ids()).not.toContain(`m-${lowest - 1}`);
      expect(ids()).toHaveLength(2 + 100 * MAIL_PAGES_MAX);
    });
  });

  describe('rereadRoom', () => {
    it('диапазон укладывается в потолок: страницы идут вниз от вершины и останавливаются на странице с наименьшим держимым', async () => {
      const bridge = createFakeBridge();
      const cursors: Array<string | undefined> = [];
      bridge.setHandler('context.messages', hostPaging(700, cursors));
      const current = entry([unread('m-450'), unread('m-451')], 700, 450, 5);
      useWorksStore.setState({ entries: [current] });
      await rereadRoom(bridge, current, 'r-01');
      // Страница 401..500 достигает m-450: четвёртой не будет; письма вершины на месте.
      expect(cursors).toEqual([undefined, 'before:601', 'before:501']);
      expect(ids()).toContain('m-700');
      expect(ids()).toContain('m-450');
    });

    it('комнату без держимых писем не читает', async () => {
      const bridge = createFakeBridge();
      bridge.setHandler('context.messages', () => pageOf([]));
      await rereadRoom(bridge, entry([], 9, null, 5), 'r-01');
      expect(pageCalls(bridge)).toEqual([]);
    });
  });
});

describe('снимок без писем: открытие комнаты, Mail и «загрузить раньше»', () => {
  const unread = (id: string, patch: Partial<Message> = {}): Message => makeLetter(id, { roomId: 'r-01', to: [], from: 's-02', readBy: {}, ...patch });
  const pageOf = (messages: Message[], next: string | null = null) => ({
    messages,
    page: { total: 10, returned: messages.length, complete: next === null, next, bytes: 1, cut: 0 },
  });
  /** Работа с компактной картой версии 2: в комнате `r-01` девять писем, в Mail два; окно держит `held`. */
  const v2 = (held: Message[]): WindowWorkEntry =>
    withCompactMail(
      makeWork('w-01', { rooms: [makeRoom('r-01', 'К')] }),
      makeCompactMail({ rooms: { '': makeRoomNumbers({ total: 2, top: 2 }), 'r-01': makeRoomNumbers({ total: 9, top: 9 }) } }),
      held,
    );
  const ids = (): string[] => useWorksStore.getState().entries[0]!.map.messages.map((message) => message.id);

  it('открытие комнаты без писем читает последнюю страницу (без курсора) и кладёт её в карту', async () => {
    const bridge = createFakeBridge();
    const asked: unknown[] = [];
    bridge.setHandler('context.messages', (params) => {
      asked.push(params);
      return pageOf([unread('m-08'), unread('m-09')], 'before:8');
    });
    const current = v2([]);
    useWorksStore.setState({ entries: [current] });
    await openRoom(bridge, current, 'r-01');
    expect(asked).toEqual([{ projectPath: '/tmp/proj', workId: 'w-01', roomId: 'r-01' }]);
    expect(ids()).toEqual(['m-08', 'm-09']);
    expect(heldPolicy('/tmp/proj', 'w-01').isOpen('r-01')).toBe(true);
    expect(heldPolicy('/tmp/proj', 'w-01').isOpen('r-02')).toBe(false);
  });

  it('комната, письма которой окно уже держит, не читается заново, но помечается открытой; два открытия подряд — один запрос', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('context.messages', () => pageOf([unread('m-09')]));
    const held = v2([unread('m-09')]);
    await openRoom(bridge, held, 'r-01');
    expect(bridge.calls).toEqual([]);
    expect(heldPolicy('/tmp/proj', 'w-01').isOpen('r-01')).toBe(true);

    useWorksStore.setState({ entries: [v2([])] });
    await Promise.all([openRoom(bridge, v2([]), 'r-02'), openRoom(bridge, v2([]), 'r-02')]);
    expect(bridge.calls.filter((call) => call.method === 'context.messages')).toHaveLength(1);
  });

  it('Mail при открытии читает roomId null; комната или работа удалены, пока шёл запрос, — не сбой; другой отказ уходит вызывающему', async () => {
    const bridge = createFakeBridge();
    const asked: unknown[] = [];
    bridge.setHandler('context.messages', (params) => {
      asked.push(params);
      return pageOf([unread('m-01', { roomId: null, to: ['human'] }), unread('m-02', { roomId: null, to: ['human'] })]);
    });
    const current = v2([]);
    useWorksStore.setState({ entries: [current] });
    await openMail(bridge, current);
    expect(asked).toEqual([{ projectPath: '/tmp/proj', workId: 'w-01', roomId: null }]);
    expect(ids()).toEqual(['m-01', 'm-02']);
    expect(heldPolicy('/tmp/proj', 'w-01').isOpen(null)).toBe(true);

    bridge.setHandler('context.messages', () => {
      throw { code: 'not_found', message: 'room r-01 does not exist' };
    });
    await expect(openRoom(bridge, v2([]), 'r-01')).resolves.toBeUndefined();
    bridge.setHandler('context.messages', () => {
      throw { code: 'internal', message: 'нет' };
    });
    await expect(openRoom(bridge, v2([]), 'r-01')).rejects.toMatchObject({ code: 'internal' });
    // После отказа комната снова просится в чтение: следующее открытие не считает её прочитанной.
    expect(asked).toHaveLength(1);
    bridge.setHandler('context.messages', () => pageOf([]));
    await expect(openRoom(bridge, v2([]), 'r-01')).resolves.toBeUndefined();
  });

  describe('неудачное открытие', () => {
    const failing = (bridge: ReturnType<typeof createFakeBridge>, outcomes: Array<'fail' | 'ok'>): { calls: () => number } => {
      let calls = 0;
      bridge.setHandler('context.messages', () => {
        const outcome = outcomes[Math.min(calls, outcomes.length - 1)];
        calls += 1;
        if (outcome === 'fail') throw { code: 'internal', message: 'нет' };
        return pageOf([unread('m-08'), unread('m-09')]);
      });
      return { calls: () => calls };
    };

    it('неудачное открытие повторяется: через 1 с, после каждого сбоя подряд вдвое дольше, пока страница не придёт', async () => {
      vi.useFakeTimers();
      try {
        const bridge = createFakeBridge();
        const read = failing(bridge, ['fail', 'fail', 'ok']);
        const current = v2([]);
        useWorksStore.setState({ entries: [current] });
        await expect(openRoom(bridge, current, 'r-01')).rejects.toMatchObject({ code: 'internal' });
        expect(read.calls()).toBe(1);
        await vi.advanceTimersByTimeAsync(999);
        expect(read.calls()).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(read.calls()).toBe(2);
        // Второй сбой подряд — отступ 2 с.
        await vi.advanceTimersByTimeAsync(1999);
        expect(read.calls()).toBe(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(read.calls()).toBe(3);
        expect(ids()).toEqual(['m-08', 'm-09']);
        // Страница пришла — больше не читается.
        await vi.advanceTimersByTimeAsync(120_000);
        expect(read.calls()).toBe(3);
      } finally {
        stopOpenRetries();
        vi.useRealTimers();
      }
    });

    it('отступ растёт до потолка в 30 с', async () => {
      vi.useFakeTimers();
      try {
        const bridge = createFakeBridge();
        const read = failing(bridge, ['fail']);
        const current = v2([]);
        useWorksStore.setState({ entries: [current] });
        await expect(openRoom(bridge, current, 'r-01')).rejects.toBeDefined();
        // 1 + 2 + 4 + 8 + 16 с — пять повторов, шестой отступ уже 30 с, а не 32.
        await vi.advanceTimersByTimeAsync(31_000);
        expect(read.calls()).toBe(6);
        await vi.advanceTimersByTimeAsync(29_999);
        expect(read.calls()).toBe(6);
        await vi.advanceTimersByTimeAsync(1);
        expect(read.calls()).toBe(7);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(read.calls()).toBe(8);
      } finally {
        stopOpenRetries();
        vi.useRealTimers();
      }
    });

    it('письма комнаты встали сами (событие), работа ушла или комната закрыта — повтор ничего не читает', async () => {
      vi.useFakeTimers();
      try {
        const bridge = createFakeBridge();
        const read = failing(bridge, ['fail']);
        const current = v2([]);
        useWorksStore.setState({ entries: [current] });
        await expect(openRoom(bridge, current, 'r-01')).rejects.toBeDefined();
        useWorksStore.getState().addMail('/tmp/proj', 'w-01', [unread('m-09')]);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(read.calls()).toBe(1);

        useWorksStore.setState({ entries: [v2([])] });
        await expect(openRoom(bridge, v2([]), 'r-01')).rejects.toBeDefined();
        useWorksStore.setState({ entries: [] });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(read.calls()).toBe(2);

        useWorksStore.setState({ entries: [v2([])] });
        await expect(openRoom(bridge, v2([]), 'r-01')).rejects.toBeDefined();
        useRoomPagesStore.setState({ opened: {} });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(read.calls()).toBe(3);
      } finally {
        stopOpenRetries();
        vi.useRealTimers();
      }
    });

    it('открытие заново (панель смонтирована снова) читает сразу и отменяет ожидающий повтор; stopOpenRetries повторы снимает', async () => {
      vi.useFakeTimers();
      try {
        const bridge = createFakeBridge();
        const read = failing(bridge, ['fail', 'ok']);
        const current = v2([]);
        useWorksStore.setState({ entries: [current] });
        await expect(openRoom(bridge, current, 'r-01')).rejects.toBeDefined();
        await openRoom(bridge, current, 'r-01');
        expect(read.calls()).toBe(2);
        expect(ids()).toEqual(['m-08', 'm-09']);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(read.calls()).toBe(2);

        // Отключение: стор работ снимает повторы, и мост, который уже не ответит, больше не зовётся.
        useWorksStore.setState({ entries: [v2([])] });
        failing(bridge, ['fail']);
        await expect(openRoom(bridge, v2([]), 'r-02')).rejects.toBeDefined();
        const before = bridge.calls.length;
        stopOpenRetries();
        await vi.advanceTimersByTimeAsync(120_000);
        expect(bridge.calls.length).toBe(before);
      } finally {
        stopOpenRetries();
        vi.useRealTimers();
      }
    });
  });

  it('загрузить раньше: итог берётся из compact версии 2, курсор — перед наименьшим держимым номером', async () => {
    const bridge = createFakeBridge();
    const cursors: Array<string | undefined> = [];
    bridge.setHandler('context.messages', (params) => {
      cursors.push(params.cursor);
      return pageOf([unread('m-06'), unread('m-07')], 'before:6');
    });
    const current = v2([unread('m-08'), unread('m-09')]);
    useWorksStore.setState({ entries: [current] });
    await useRoomPagesStore.getState().loadEarlier(bridge, current, 'r-01', (messages) => useWorksStore.getState().addMessages('/tmp/proj', 'w-01', messages));
    expect(cursors).toEqual(['before:8']);
    expect(ids()).toEqual(['m-06', 'm-07', 'm-08', 'm-09']);
    // Подгруженная история переживает следующий снимок: граница — по цепочке.
    expect(heldPolicy('/tmp/proj', 'w-01').floor('r-01')).toBe(6);
    expect(heldPolicy('/tmp/proj', 'w-01').floor('r-02')).toBeUndefined();
  });

  it('дочитанная цепочка: всю историю окно не отбрасывает (граница 0)', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('context.messages', () => pageOf([unread('m-01')]));
    const current = v2([unread('m-02')]);
    await useRoomPagesStore.getState().loadEarlier(bridge, current, 'r-01', () => {});
    expect(heldPolicy('/tmp/proj', 'w-01').floor('r-01')).toBe(0);
  });

  describe('оригинал цитаты по id', () => {
    it('loadQuote запрашивает context.letter один раз на id и помнит ответ, в том числе «письма нет»', async () => {
      const bridge = createFakeBridge();
      const asked: unknown[] = [];
      bridge.setHandler('context.letter', (params) => {
        asked.push(params);
        return { message: params.id === 'm-03' ? unread('m-03', { text: 'исходное' }) : null };
      });
      const current = v2([]);
      const { loadQuote } = useRoomPagesStore.getState();
      await Promise.all([loadQuote(bridge, current, 'm-03'), loadQuote(bridge, current, 'm-03'), loadQuote(bridge, current, 'm-04')]);
      await loadQuote(bridge, current, 'm-03');
      expect(asked).toEqual([
        { projectPath: '/tmp/proj', workId: 'w-01', id: 'm-03' },
        { projectPath: '/tmp/proj', workId: 'w-01', id: 'm-04' },
      ]);
      const quotes = useRoomPagesStore.getState().quotes['/tmp/proj\u0000w-01'];
      expect(quotes?.['m-03']?.text).toBe('исходное');
      expect(quotes?.['m-04']).toBeNull();
    });

    it('сбой запроса не оставляет id вечно «ожидающим»: следующая попытка идёт заново', async () => {
      const bridge = createFakeBridge();
      let fail = true;
      bridge.setHandler('context.letter', () => {
        if (fail) throw { code: 'internal', message: 'нет' };
        return { message: unread('m-03') };
      });
      const current = v2([]);
      await expect(useRoomPagesStore.getState().loadQuote(bridge, current, 'm-03')).rejects.toBeDefined();
      expect(useRoomPagesStore.getState().quotes['/tmp/proj\u0000w-01']?.['m-03']).toBeUndefined();
      fail = false;
      await useRoomPagesStore.getState().loadQuote(bridge, current, 'm-03');
      expect(useRoomPagesStore.getState().quotes['/tmp/proj\u0000w-01']?.['m-03']?.id).toBe('m-03');
    });
  });
});
