import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MapCompact, Message, Room, WindowWorkEntry } from '@parley/core';
import { ROOMS_MAIL_FEATURE, type RoomsMailEvent, type RoomsMailRoom, type WorksSnapshot } from '@parley/protocol';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { makeLetter, makeMailEvent, makeMailRoom, makeRoom, makeWork } from '../test-utils/work-fixtures.js';
import { MAIL_PAGES_MAX } from './room-pages.js';
import { orderedWorks, useWorksStore } from './works.js';

function entry(id: string, createdAt: string): WindowWorkEntry {
  return {
    projectPath: '/tmp/proj',
    map: {
      schemaVersion: 2,
      rooms: [],
      work: { id, title: id, goal: '', status: 'active', createdAt, updatedAt: createdAt },
      sessions: [],
      messages: [],
    },
  };
}

beforeEach(() => {
  useWorksStore.setState({ entries: [], branches: {}, loading: true, error: null });
});

describe('useWorksStore.init', () => {
  it('запрашивает works.list при старте', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('works.list', () => ({ entries: [entry('w-01', '2026-01-01')], branches: {} }));

    const dispose = useWorksStore.getState().init(bridge);
    await Promise.resolve();
    await Promise.resolve();

    expect(useWorksStore.getState().entries).toHaveLength(1);
    expect(useWorksStore.getState().loading).toBe(false);
    dispose();
  });

  // Хост рассылает снимок ещё до ворот `worksReady` (разбор 2026-10-14): окно уже рисует комнату, а методы снимка
  // (`rooms.resolveProposal`) ждут. Готовность — только ответ `works.list`; переподключение начинает её заново.
  it('ready — только после ответа works.list: рассылка до него ворот не открывает', async () => {
    const bridge = createFakeBridge();
    let answer!: () => void;
    bridge.setHandler(
      'works.list',
      () => new Promise((resolve) => (answer = () => resolve({ entries: [entry('w-01', '2026-01-01')], branches: {} }))),
    );
    useWorksStore.setState({ ready: true });
    const dispose = useWorksStore.getState().init(bridge);
    expect(useWorksStore.getState().ready).toBe(false);

    bridge.emit('works.changed', { entries: [entry('w-01', '2026-01-01')], branches: {} });
    expect(useWorksStore.getState().loading).toBe(false);
    expect(useWorksStore.getState().ready).toBe(false);

    answer();
    await vi.waitFor(() => expect(useWorksStore.getState().ready).toBe(true));
    dispose();
  });

  it('works.changed обновляет список без повторного call', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('works.list', () => ({ entries: [], branches: {} }));
    const dispose = useWorksStore.getState().init(bridge);
    await Promise.resolve();
    await Promise.resolve();

    bridge.emit('works.changed', { entries: [entry('w-02', '2026-01-02')], branches: { '/tmp/proj': 'main' } });

    expect(useWorksStore.getState().entries.map((item) => item.map.work.id)).toEqual(['w-02']);
    expect(useWorksStore.getState().branches).toEqual({ '/tmp/proj': 'main' });
    dispose();
  });

  it('ошибка call — error в сторе, а не падение', async () => {
    const bridge = createFakeBridge();
    // Нет setHandler('works.list', ...) — fake-bridge сам отклонит вызов.
    const dispose = useWorksStore.getState().init(bridge);
    await Promise.resolve();
    await Promise.resolve();

    expect(useWorksStore.getState().error).not.toBeNull();
    // Снимка нет — «загружено» не наступило (lane-r5): иначе пустой список сошёл бы за ответ хоста,
    // и первый снимок раскладок (retainLayouts) стёр бы сохранённые вкладки всех работ.
    expect(useWorksStore.getState().loading).toBe(true);
    dispose();
  });

  it('отказ хоста с причиной — error несёт код и причину; прежний снимок не трогается (lane-r5)', async () => {
    const bridge = createFakeBridge();
    const kept = entry('w-01', '2026-01-01');
    useWorksStore.setState({ entries: [kept], branches: {}, loading: false, error: null });
    bridge.setHandler('works.list', () => {
      // Причина — в `data.reason`, как у ошибок git 8.2a (форма ветки после слияния).
      throw { code: 'internal', message: 'работы не прочитаны', data: { reason: 'works-unreadable' } };
    });
    const dispose = useWorksStore.getState().init(bridge);
    await Promise.resolve();
    await Promise.resolve();

    expect(useWorksStore.getState().error).toEqual({ code: 'internal', reason: 'works-unreadable' });
    expect(useWorksStore.getState().entries).toEqual([kept]);
    expect(useWorksStore.getState().loading).toBe(false);
    dispose();
  });

  it('data.reason не строкой — причины нет (reason: null), остаётся код (слияние с 8.2a)', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('works.list', () => {
      throw { code: 'internal', message: 'x', data: { reason: 7 } };
    });
    const dispose = useWorksStore.getState().init(bridge);
    await Promise.resolve();
    await Promise.resolve();

    expect(useWorksStore.getState().error).toEqual({ code: 'internal', reason: null });
    dispose();
  });

  it('dispose снимает подписку — works.changed после неё не применяется', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('works.list', () => ({ entries: [], branches: {} }));
    const dispose = useWorksStore.getState().init(bridge);
    await Promise.resolve();
    await Promise.resolve();
    dispose();

    bridge.emit('works.changed', { entries: [entry('w-03', '2026-01-03')], branches: {} });

    expect(useWorksStore.getState().entries).toEqual([]);
  });
});

describe('orderedWorks', () => {
  it('сортирует по времени создания', () => {
    const b = entry('w-b', '2026-01-02');
    const a = entry('w-a', '2026-01-01');
    expect(orderedWorks([b, a]).map((item) => item.map.work.id)).toEqual(['w-a', 'w-b']);
  });
});

describe('useWorksStore: rooms.mail (спека rooms.mail 6.3-6.5)', () => {
  const letter = (id: string, patch: Partial<Message> = {}): Message => makeLetter(id, { roomId: 'r-01', to: [], from: 's-02', readBy: {}, ...patch });
  const seqOf = (message: Message): number => Number(message.id.slice(2));

  /** Работа с комнатой `r-01` (и другими по просьбе), письмами снимка, счётчиками хоста и версией; `version: undefined` — снимок без версии. */
  function work(messages: Message[], total: number, version: number | undefined, rooms: Room[] = [makeRoom('r-01', 'К')]): WindowWorkEntry {
    const base = makeWork('w-01', { rooms, messages });
    const first = messages.filter((message) => message.roomId === 'r-01').map(seqOf);
    const compact: MapCompact = {
      version: 1,
      messages: { total, included: messages.length, latestId: `m-${total}`, rooms: { 'r-01': { total, included: messages.length, tailFrom: first.length === 0 ? null : Math.min(...first) } } },
      unread: { letters: 0, rooms: {} },
      cut: [],
      omitted: {},
    };
    return { ...base, map: { ...base.map, compact }, ...(version === undefined ? {} : { version }) };
  }

  const snapshot = (revision: number, ...entries: WindowWorkEntry[]): WorksSnapshot => ({ entries, branches: {}, revision });
  const page = (messages: Message[]) => ({ messages, page: { total: messages.length, returned: messages.length, complete: true, next: null, bytes: 1, cut: 0 } });
  const ids = (): string[] => useWorksStore.getState().entries[0]!.map.messages.map((message) => message.id);
  const compactOf = (): MapCompact => useWorksStore.getState().entries[0]!.map.compact!;
  const pageCalls = (bridge: FakeBridge): Array<string | undefined> =>
    bridge.calls.filter((call) => call.method === 'context.messages').map((call) => (call.params as { cursor?: string }).cursor);

  /** Слушатели `onMail` живут в модуле: каждый тест снимает свои. */
  const unsubscribe: Array<() => void> = [];
  const listen = (listener: (event: RoomsMailEvent) => void): void => {
    unsubscribe.push(useWorksStore.getState().onMail(listener));
  };
  afterEach(() => {
    for (const off of unsubscribe.splice(0)) off();
  });

  /** Окно подключено к хосту с признаком (или без: `features: null`) и получило снимок. */
  async function start(entry: WindowWorkEntry, features: string[] | null = [ROOMS_MAIL_FEATURE]) {
    const bridge = createFakeBridge();
    bridge.emitStatus({ state: 'connected', hostVersion: '0.0.0-test', methods: null, features });
    bridge.setHandler('works.list', () => snapshot(1, entry));
    const dispose = useWorksStore.getState().init(bridge);
    await vi.waitFor(() => expect(useWorksStore.getState().entries).toHaveLength(1));
    return { bridge, dispose };
  }

  const roomBatch = (letters: Message[], patch: Partial<RoomsMailRoom> = {}) =>
    makeMailRoom('r-01', { prevTop: 9, top: 10, total: 10, letters, ...patch });

  it('событие с prevVersion = held применяется без запросов; слушатель зовётся после применения и снимается', async () => {
    const { bridge, dispose } = await start(work([letter('m-08'), letter('m-09')], 9, 5));
    const seen: string[][] = [];
    const off = useWorksStore.getState().onMail(() => void seen.push(ids()));

    bridge.emit('rooms.mail', makeMailEvent({ version: 6, prevVersion: 5, rooms: [roomBatch([letter('m-10')])], unread: { letters: 1, rooms: { '': 0, 'r-01': 1 } } }));

    expect(ids()).toEqual(['m-08', 'm-09', 'm-10']);
    expect(pageCalls(bridge)).toEqual([]);
    expect(seen).toEqual([['m-08', 'm-09', 'm-10']]);
    expect(compactOf().unread).toEqual({ letters: 0, rooms: { 'r-01': 1 } });
    off();
    bridge.emit('rooms.mail', makeMailEvent({ version: 7, prevVersion: 6, rooms: [roomBatch([letter('m-11')], { prevTop: 10, top: 11, total: 11 })] }));
    expect(ids()).toHaveLength(4);
    expect(seen).toHaveLength(1);
    dispose();
  });

  it('разрыв версии: письмо события применяется, repairWork читает от вершины вниз до наименьшего держимого seq и обновляет readBy старых писем', async () => {
    const { bridge, dispose } = await start(work([letter('m-08'), letter('m-09')], 9, 5));
    bridge.setHandler('context.messages', () =>
      page([letter('m-08', { readBy: { human: 'T' } }), letter('m-09', { readBy: { human: 'T' } }), letter('m-10')]),
    );

    bridge.emit('rooms.mail', makeMailEvent({ version: 8, prevVersion: 7, rooms: [roomBatch([letter('m-10')])] }));
    expect(ids()).toEqual(['m-08', 'm-09', 'm-10']);
    await vi.waitFor(() => expect(useWorksStore.getState().entries[0]!.map.messages[0]?.readBy).toEqual({ human: 'T' }));

    // Без курсора — страница от вершины; m-08 — наименьший держимый номер, страница его достигает, дальше читать нечего.
    expect(pageCalls(bridge)).toEqual([undefined]);
    expect(useWorksStore.getState().entries[0]!.map.messages[1]?.readBy).toEqual({ human: 'T' });
    // Версия 8 держится: следующее событие по цепочке запросов не требует.
    bridge.emit('rooms.mail', makeMailEvent({ version: 9, prevVersion: 8, rooms: [roomBatch([letter('m-11')], { prevTop: 10, top: 11, total: 11 })] }));
    expect(pageCalls(bridge)).toHaveLength(1);
    dispose();
  });

  it('починка читает и Mail, если окно держит прямые письма; комнату без держимых писем не читает', async () => {
    const mail = letter('m-07', { roomId: null, to: ['human'] });
    const { bridge, dispose } = await start(work([letter('m-08'), mail], 9, 5, [makeRoom('r-01', 'К'), makeRoom('r-02', 'Вторая')]));
    const asked: Array<{ roomId: string | null; cursor?: string }> = [];
    bridge.setHandler('context.messages', (params) => {
      asked.push({ roomId: params.roomId, ...(params.cursor === undefined ? {} : { cursor: params.cursor }) });
      return page([]);
    });
    bridge.emit('rooms.mail', makeMailEvent({ version: 8, prevVersion: 7 }));
    await vi.waitFor(() => expect(asked).toHaveLength(2));
    expect(asked).toEqual(expect.arrayContaining([{ roomId: 'r-01' }, { roomId: null }]));
    dispose();
  });

  it('сбой починки не оставляет окно уверенным: следующее событие снова считается разрывом', async () => {
    const { bridge, dispose } = await start(work([letter('m-08')], 8, 5));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let fail = true;
    bridge.setHandler('context.messages', () => {
      if (fail) throw { code: 'internal', message: 'нет' };
      return page([]);
    });
    bridge.emit('rooms.mail', makeMailEvent({ version: 8, prevVersion: 7 }));
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    fail = false;
    bridge.emit('rooms.mail', makeMailEvent({ version: 9, prevVersion: 8 }));
    await vi.waitFor(() => expect(pageCalls(bridge)).toHaveLength(2));
    warn.mockRestore();
    dispose();
  });

  it('держимый диапазон больше потолка страниц: письма вершины доходят, починка — сбой, и следующее событие читает снова', async () => {
    const top = 100 * (MAIL_PAGES_MAX + 5);
    const { bridge, dispose } = await start(work([letter('m-1'), letter('m-2')], 2, 5));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Хост листает комнату от вершины вниз по сотне писем: курсор `before:N` называет номер.
    bridge.setHandler('context.messages', (params) => {
      const below = params.cursor === undefined ? top + 1 : Number(params.cursor.slice('before:'.length));
      const from = Math.max(1, below - 100);
      const messages = Array.from({ length: below - from }, (_, index) => letter(`m-${from + index}`));
      return { messages, page: { total: top, returned: messages.length, complete: from === 1, next: from === 1 ? null : `before:${from}`, bytes: 1, cut: 0 } };
    });
    bridge.emit('rooms.mail', makeMailEvent({ version: 8, prevVersion: 7, rooms: [roomBatch([letter(`m-${top}`)], { prevTop: 2, top, total: top })] }));
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());

    // Потолок обрезал старый конец: самые новые письма пришли, дыра осталась внизу, и окно не считает себя починенным.
    expect(pageCalls(bridge)).toHaveLength(MAIL_PAGES_MAX);
    expect(ids()).toContain(`m-${top - 1}`);
    expect(ids()).toContain(`m-${top - 100 * MAIL_PAGES_MAX + 1}`);
    expect(ids()).not.toContain(`m-${top - 100 * MAIL_PAGES_MAX}`);
    bridge.emit('rooms.mail', makeMailEvent({ version: 9, prevVersion: 8, rooms: [roomBatch([letter(`m-${top + 1}`)], { prevTop: top, top: top + 1, total: top + 1 })] }));
    await vi.waitFor(() => expect(pageCalls(bridge)).toHaveLength(2 * MAIL_PAGES_MAX));
    warn.mockRestore();
    dispose();
  });

  it('комната, которую починка уже не нашла на хосте (not_found), — не сбой', async () => {
    const { bridge, dispose } = await start(work([letter('m-08')], 8, 5));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    bridge.setHandler('context.messages', () => {
      throw { code: 'not_found', message: 'room r-01 does not exist' };
    });
    bridge.emit('rooms.mail', makeMailEvent({ version: 8, prevVersion: 7 }));
    await vi.waitFor(() => expect(pageCalls(bridge)).toHaveLength(1));
    bridge.emit('rooms.mail', makeMailEvent({ version: 9, prevVersion: 8 }));
    expect(pageCalls(bridge)).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    dispose();
  });

  it('снимок без версии: окно не знает, чем располагает, и первое событие считает разрывом, а дальше версия известна', async () => {
    const { bridge, dispose } = await start(work([letter('m-08')], 8, undefined));
    bridge.setHandler('context.messages', () => page([letter('m-08')]));
    bridge.emit('rooms.mail', makeMailEvent({ version: 6, prevVersion: 5, rooms: [roomBatch([letter('m-09')], { prevTop: 8, top: 9, total: 9 })] }));
    await vi.waitFor(() => expect(pageCalls(bridge)).toEqual([undefined]));
    bridge.emit('rooms.mail', makeMailEvent({ version: 7, prevVersion: 6, rooms: [roomBatch([letter('m-10')], { prevTop: 9, top: 10, total: 10 })] }));
    expect(pageCalls(bridge)).toHaveLength(1);
    expect(ids()).toEqual(['m-08', 'm-09', 'm-10']);
    dispose();
  });

  it('версия сходится, а верх комнаты у окна ниже prevTop: followRoom дочитывает от вершины вниз до своего верха', async () => {
    const { bridge, dispose } = await start(work([letter('m-08'), letter('m-09')], 9, 5));
    bridge.setHandler('context.messages', () => page([letter('m-10'), letter('m-11'), letter('m-12')]));
    bridge.emit('rooms.mail', makeMailEvent({ version: 6, prevVersion: 5, rooms: [roomBatch([letter('m-12')], { prevTop: 11, top: 12, total: 12 })] }));
    await vi.waitFor(() => expect(ids()).toEqual(['m-08', 'm-09', 'm-10', 'm-11', 'm-12']));
    expect(pageCalls(bridge)).toEqual([undefined]);
    dispose();
  });

  it('reread: держимая комната читается с начала держимого, чужая и пустая — нет', async () => {
    const { bridge, dispose } = await start(work([letter('m-08')], 8, 5, [makeRoom('r-01', 'К'), makeRoom('r-02', 'Вторая')]));
    bridge.setHandler('context.messages', () => page([letter('m-08', { readBy: { human: 'T' } })]));
    bridge.emit(
      'rooms.mail',
      makeMailEvent({
        version: 6,
        prevVersion: 5,
        rooms: [makeMailRoom('r-01', { prevTop: 8, top: 8, total: 8, reread: true }), makeMailRoom('r-02', { prevTop: 0, top: 0, total: 0, reread: true })],
      }),
    );
    await vi.waitFor(() => expect(useWorksStore.getState().entries[0]!.map.messages[0]?.readBy).toEqual({ human: 'T' }));
    expect(pageCalls(bridge)).toEqual([undefined]);
    dispose();
  });

  it('событие раньше снимка с комнатой ждёт снимка этой работы с version >= версии события и применяется', async () => {
    const { bridge, dispose } = await start(work([letter('m-08')], 8, 5));
    const delivered: string[][] = [];
    listen((event) => void delivered.push(event.rooms.map((room) => room.roomId ?? 'direct')));
    bridge.emit(
      'rooms.mail',
      makeMailEvent({ version: 6, prevVersion: 5, rooms: [makeMailRoom('r-02', { prevTop: 0, top: 11, total: 1, letters: [letter('m-11', { roomId: 'r-02' })] })] }),
    );
    expect(ids()).toEqual(['m-08']);

    // Снимок, собранный до записи (version 5) и без комнаты: ждать дальше.
    bridge.emit('works.changed', snapshot(2, work([letter('m-08')], 8, 5)));
    expect(ids()).toEqual(['m-08']);
    expect(delivered).toEqual([]);

    // Снимок записи: комната есть — событие применяется.
    bridge.emit('works.changed', snapshot(3, work([letter('m-08')], 8, 6, [makeRoom('r-01', 'К'), makeRoom('r-02', 'Вторая')])));
    expect(ids()).toEqual(['m-08', 'm-11']);
    expect(delivered).toEqual([['r-02']]);
    expect(pageCalls(bridge)).toEqual([]);
    dispose();
  });

  it('события работы идут по порядку: пока первое ждёт снимка, следующее не обгоняет его', async () => {
    const { bridge, dispose } = await start(work([letter('m-08')], 8, 5));
    const delivered: number[] = [];
    listen((event) => void delivered.push(event.version));
    const second = [makeRoom('r-01', 'К'), makeRoom('r-02', 'Вторая')];
    bridge.emit(
      'rooms.mail',
      makeMailEvent({ version: 6, prevVersion: 5, rooms: [makeMailRoom('r-02', { prevTop: 0, top: 11, total: 1, letters: [letter('m-11', { roomId: 'r-02' })] })] }),
    );
    bridge.emit('rooms.mail', makeMailEvent({ version: 7, prevVersion: 6, rooms: [roomBatch([letter('m-12')], { prevTop: 8, top: 12, total: 9 })] }));
    expect(delivered).toEqual([]);
    expect(ids()).toEqual(['m-08']);

    bridge.emit('works.changed', snapshot(2, work([letter('m-08')], 8, 7, second)));
    expect(delivered).toEqual([6, 7]);
    expect(ids()).toEqual(['m-08', 'm-11', 'm-12']);
    dispose();
  });

  it('очередь ждущих событий ограничена: самые старые теряются, потерянное звено чинится как разрыв версии', async () => {
    const { bridge, dispose } = await start(work([], 0, 5));
    const delivered: number[] = [];
    listen((event) => void delivered.push(event.version));
    // Работы `w-02` в снимке нет: её события ждут. Их больше предела — сохраняются последние.
    for (let version = 6; version <= 45; version += 1) {
      bridge.emit('rooms.mail', makeMailEvent({ workId: 'w-02', version, prevVersion: version - 1, rooms: [makeMailRoom(null, { letters: [letter(`m-${version}`, { roomId: null })] })] }));
    }
    expect(delivered).toEqual([]);
    bridge.emit('works.changed', snapshot(2, work([], 0, 5), { ...makeWork('w-02'), version: 5 }));
    expect(delivered).toEqual(Array.from({ length: 32 }, (_, at) => 14 + at));
    // Первая из оставшихся (14) не сходится с версией окна (5): разрыв, но держимых писем нет — читать нечего.
    expect(pageCalls(bridge)).toEqual([]);
    dispose();
  });

  it('событие удалённой комнаты выбрасывается: сразу, если снимок не старее события, и после снимка, если ждало', async () => {
    const { bridge, dispose } = await start(work([letter('m-08')], 8, 7));
    const delivered = vi.fn();
    listen(delivered);
    const ghost = (version: number, prevVersion: number) =>
      makeMailEvent({ version, prevVersion, rooms: [makeMailRoom('r-03', { prevTop: 0, top: 11, total: 1, letters: [letter('m-11', { roomId: 'r-03' })] })] });

    // Снимок версии 7 уже свежее события 7: комнаты в нём нет, значит, она удалена той же записью.
    bridge.emit('rooms.mail', ghost(7, 6));
    expect(ids()).toEqual(['m-08']);
    expect(delivered).not.toHaveBeenCalled();

    // Событие 9 снимок версии 7 ещё не покрывает: ждёт. Снимок 9 комнаты не принёс — событие выброшено, комната не воскресла.
    bridge.emit('rooms.mail', ghost(9, 8));
    expect(ids()).toEqual(['m-08']);
    bridge.emit('works.changed', snapshot(2, work([letter('m-08')], 8, 9)));
    expect(ids()).toEqual(['m-08']);
    expect(delivered).not.toHaveBeenCalled();
    // Очередь освободилась: следующее событие идёт своим путём.
    bridge.emit('rooms.mail', makeMailEvent({ version: 10, prevVersion: 9, rooms: [roomBatch([letter('m-09')], { prevTop: 8, top: 9, total: 9 })] }));
    expect(ids()).toEqual(['m-08', 'm-09']);
    expect(pageCalls(bridge)).toEqual([]);
    dispose();
  });

  it('числа присваиваются, а не прибавляются: два одинаковых события дают те же числа', async () => {
    const { bridge, dispose } = await start(work([letter('m-08'), letter('m-09')], 9, 5));
    const event = makeMailEvent({ version: 6, prevVersion: 5, rooms: [roomBatch([letter('m-10')])], unread: { letters: 4, rooms: { '': 1, 'r-01': 3 } } });

    bridge.emit('rooms.mail', event);
    const first = structuredClone(compactOf());
    bridge.emit('rooms.mail', event);

    expect(compactOf()).toEqual(first);
    expect(compactOf().unread).toEqual({ letters: 1, rooms: { 'r-01': 3 } });
    expect(compactOf().messages.total).toBe(10);
    expect(ids()).toEqual(['m-08', 'm-09', 'm-10']);

    // Следующее событие ставит свои числа, а не прибавляет к прежним.
    bridge.emit(
      'rooms.mail',
      makeMailEvent({ version: 7, prevVersion: 6, rooms: [roomBatch([letter('m-11')], { prevTop: 10, top: 11, total: 11 })], unread: { letters: 4, rooms: { '': 1, 'r-01': 3 } } }),
    );
    expect(compactOf().unread).toEqual({ letters: 1, rooms: { 'r-01': 3 } });
    expect(compactOf().messages.total).toBe(11);
    dispose();
  });

  it('отметка человека во время события в пути: итог равен событию, запоздалый повтор прежнего события его не откатывает', async () => {
    const { bridge, dispose } = await start(work([letter('m-08'), letter('m-09')], 9, 5));
    const arrived = makeMailEvent({ version: 6, prevVersion: 5, rooms: [roomBatch([letter('m-10')])], unread: { letters: 1, rooms: { '': 0, 'r-01': 1 } } });
    const marked = makeMailEvent({
      version: 7,
      prevVersion: 6,
      rooms: [makeMailRoom('r-01', { prevTop: 10, top: 10, total: 10, reads: [{ id: 'm-10', reader: 'human', at: 'T' }] })],
      unread: { letters: 0, rooms: {} },
    });

    bridge.emit('rooms.mail', arrived);
    bridge.emit('rooms.mail', marked);
    expect(useWorksStore.getState().entries[0]!.map.messages.at(-1)?.readBy).toEqual({ human: 'T' });
    expect(compactOf().unread).toEqual({ letters: 0, rooms: {} });

    bridge.emit('rooms.mail', arrived);
    expect(useWorksStore.getState().entries[0]!.map.messages.at(-1)?.readBy).toEqual({ human: 'T' });
    expect(compactOf().unread).toEqual({ letters: 0, rooms: {} });
    expect(ids()).toEqual(['m-08', 'm-09', 'm-10']);
    expect(pageCalls(bridge)).toEqual([]);
    dispose();
  });

  it('снимок новее события: числа запоздавшего события снимок не откатывают, письма и отметки сливаются', async () => {
    const { bridge, dispose } = await start(work([letter('m-08')], 8, 9));
    bridge.emit(
      'rooms.mail',
      makeMailEvent({ version: 8, prevVersion: 7, rooms: [roomBatch([letter('m-09')], { prevTop: 8, top: 9, total: 9 })], unread: { letters: 2, rooms: { '': 0, 'r-01': 2 } } }),
    );
    expect(compactOf().unread).toEqual({ letters: 0, rooms: {} });
    expect(compactOf().messages.total).toBe(8);
    expect(ids()).toEqual(['m-08', 'm-09']);
    expect(pageCalls(bridge)).toEqual([]);
    dispose();
  });

  it('прежний хост без rooms-mail в status.features: событие не читается, окно живёт по works.changed как раньше', async () => {
    for (const features of [null, ['compact-works']]) {
      useWorksStore.setState({ entries: [], branches: {}, loading: true, error: null });
      const { bridge, dispose } = await start(work([letter('m-08')], 8, 5), features);
      const delivered = vi.fn();
      const off = useWorksStore.getState().onMail(delivered);
      bridge.emit('rooms.mail', makeMailEvent({ version: 6, prevVersion: 5, rooms: [roomBatch([letter('m-09')], { prevTop: 8, top: 9, total: 9 })] }));
      expect(ids()).toEqual(['m-08']);
      expect(delivered).not.toHaveBeenCalled();
      expect(pageCalls(bridge)).toEqual([]);
      bridge.emit('works.changed', snapshot(2, work([letter('m-08'), letter('m-09')], 9, 6)));
      expect(ids()).toEqual(['m-08', 'm-09']);
      off();
      dispose();
    }
  });

  it('dispose снимает подписку на rooms.mail', async () => {
    const { bridge, dispose } = await start(work([letter('m-08')], 8, 5));
    dispose();
    bridge.emit('rooms.mail', makeMailEvent({ version: 6, prevVersion: 5, rooms: [roomBatch([letter('m-09')], { prevTop: 8, top: 9, total: 9 })] }));
    expect(ids()).toEqual(['m-08']);
  });

  it('addMail: свежая копия страницы встаёт в карту работы, чужая работа не затронута', async () => {
    const { dispose } = await start(work([letter('m-08', { readBy: {} })], 8, 5));
    useWorksStore.getState().addMail('/tmp/proj', 'w-01', [letter('m-08', { readBy: { human: 'T' } }), letter('m-09')]);
    expect(useWorksStore.getState().entries[0]!.map.messages.map((message) => message.readBy)).toEqual([{ human: 'T' }, {}]);
    useWorksStore.getState().addMail('/tmp/other', 'w-01', [letter('m-99')]);
    expect(ids()).toEqual(['m-08', 'm-09']);
    dispose();
  });
});
