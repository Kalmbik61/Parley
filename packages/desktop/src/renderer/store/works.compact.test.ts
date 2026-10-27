import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MapCompact, Message, WindowWorkEntry } from '@parley/core';
import { ROOMS_MAIL_FEATURE, type WorksSnapshot } from '@parley/protocol';
import { makeCompactMail, makeRoomNumbers, withCompactMail } from '../test-utils/compact-mail-fixtures.js';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { makeLetter, makeMailEvent, makeMailRoom, makeRoom, makeWork } from '../test-utils/work-fixtures.js';
import { openRoom, useRoomPagesStore } from './room-pages.js';
import { useWorksStore } from './works.js';

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const note = (id: string): Message => makeLetter(id, { roomId: 'r-01', to: [], from: 's-01', readBy: { human: 'x' } });
const meta = (total: number, tailFrom: number): MapCompact => ({
  version: 1,
  messages: { total, included: 0, latestId: `m-${total}`, rooms: { 'r-01': { total, included: 0, tailFrom } } },
  unread: { letters: 0, rooms: {} },
  cut: [],
  omitted: {},
});

function entry(messages: Message[], total: number, tailFrom: number, version?: number): WindowWorkEntry {
  const base = makeWork('w-01', { rooms: [makeRoom('r-01', 'К')], messages });
  return { ...base, map: { ...base.map, compact: meta(total, tailFrom) }, ...(version === undefined ? {} : { version }) };
}

const snapshot = (revision: number | undefined, entries: WindowWorkEntry[]): WorksSnapshot => ({
  entries,
  branches: {},
  ...(revision === undefined ? {} : { revision }),
});

beforeEach(() => {
  useWorksStore.setState({ entries: [], branches: {}, loading: true, error: null });
  useRoomPagesStore.setState({ chains: {}, loading: {}, opened: {}, quotes: {} });
});

describe('useWorksStore: номер снимка (P35)', () => {
  it('устаревший ответ works.list после свежего события не откатывает список', async () => {
    const bridge = createFakeBridge();
    let answer: (value: WorksSnapshot) => void = () => {};
    bridge.setHandler('works.list', () => new Promise<WorksSnapshot>((resolve) => (answer = resolve)));
    const dispose = useWorksStore.getState().init(bridge);

    bridge.emit('works.changed', snapshot(5, [entry([note('m-05')], 5, 5)]));
    answer(snapshot(4, [entry([note('m-04')], 4, 4)]));
    await flush();

    expect(useWorksStore.getState().entries[0]?.map.messages.map((message) => message.id)).toEqual(['m-05']);
    // Равный номер — повтор, не новее.
    bridge.emit('works.changed', snapshot(5, [entry([], 5, 5)]));
    expect(useWorksStore.getState().entries[0]?.map.messages).toHaveLength(1);
    bridge.emit('works.changed', snapshot(6, [entry([note('m-06')], 6, 6)]));
    expect(useWorksStore.getState().entries[0]?.map.messages.map((message) => message.id)).toEqual(['m-05', 'm-06']);
    dispose();
  });

  it('после переподключения (новый init) отсчёт начинается заново: хост мог быть другим процессом', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('works.list', () => snapshot(900, [entry([note('m-01')], 1, 1)]));
    const first = useWorksStore.getState().init(bridge);
    await flush();
    first();

    const restarted = createFakeBridge();
    restarted.setHandler('works.list', () => snapshot(1, [makeWork('w-02', { title: 'Новый' })]));
    const second = useWorksStore.getState().init(restarted);
    await flush();
    expect(useWorksStore.getState().entries.map((item) => item.map.work.id)).toEqual(['w-02']);
    second();
  });

  it('хост до P35 без номера — снимки применяются в порядке прихода', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('works.list', () => snapshot(undefined, [makeWork('w-01')]));
    const dispose = useWorksStore.getState().init(bridge);
    await flush();
    bridge.emit('works.changed', snapshot(undefined, [makeWork('w-02')]));
    bridge.emit('works.changed', snapshot(undefined, [makeWork('w-03')]));
    expect(useWorksStore.getState().entries.map((item) => item.map.work.id)).toEqual(['w-03']);
    dispose();
  });

  it('хвост сдвинулся — письма, что человек уже видел, остаются в ленте; страница старых встаёт на место', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('works.list', () => snapshot(1, [entry([note('m-03'), note('m-04')], 4, 3)]));
    const dispose = useWorksStore.getState().init(bridge);
    await flush();

    bridge.emit('works.changed', snapshot(2, [entry([note('m-04'), note('m-05')], 5, 4)]));
    expect(useWorksStore.getState().entries[0]?.map.messages.map((message) => message.id)).toEqual(['m-03', 'm-04', 'm-05']);

    useWorksStore.getState().addMessages('/tmp/proj', 'w-01', [note('m-01'), note('m-02')]);
    expect(useWorksStore.getState().entries[0]?.map.messages.map((message) => message.id)).toEqual(['m-01', 'm-02', 'm-03', 'm-04', 'm-05']);
    // Чужая работа не затронута.
    useWorksStore.getState().addMessages('/tmp/other', 'w-01', [note('m-99')]);
    expect(useWorksStore.getState().entries[0]?.map.messages).toHaveLength(5);
    dispose();
  });

  it('пропущенное окном rooms.mail: следующий снимок (переподключение или новее по номеру) содержит письмо и применяется', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('works.list', () => snapshot(5, [entry([note('m-05')], 5, 5, 5)]));
    const first = useWorksStore.getState().init(bridge);
    await flush();
    expect(useWorksStore.getState().entries[0]?.map.messages.map((message) => message.id)).toEqual(['m-05']);
    first();

    // Событие о письме m-06 окно не получило; хост же после письма сменил номер снимка (works.list отвечает с новым).
    bridge.setHandler('works.list', () => snapshot(6, [entry([note('m-05'), note('m-06')], 6, 5, 6)]));
    const second = useWorksStore.getState().init(bridge);
    await flush();
    expect(useWorksStore.getState().entries[0]?.map.messages.map((message) => message.id)).toEqual(['m-05', 'm-06']);
    second();
  });

  it('версия работы берётся из снимка: после пропущенного события следующее по цепочке применяется без починки, с разрывом — чинит', async () => {
    const bridge = createFakeBridge();
    bridge.emitStatus({ state: 'connected', hostVersion: '0.0.0-test', methods: null, features: [ROOMS_MAIL_FEATURE] });
    bridge.setHandler('works.list', () => snapshot(1, [entry([note('m-05')], 5, 5, 6)]));
    const requests: Array<string | undefined> = [];
    bridge.setHandler('context.messages', (params) => {
      requests.push(params.cursor);
      return { messages: [note('m-05'), note('m-06')], page: { total: 6, returned: 2, complete: true, next: null, bytes: 1, cut: 0 } };
    });
    const dispose = useWorksStore.getState().init(bridge);
    await flush();

    // Снимок версии 6 уже учёл пропущенное: событие 7 по цепочке (prevVersion 6) запросов не требует.
    bridge.emit('rooms.mail', makeMailEvent({ version: 7, prevVersion: 6, rooms: [makeMailRoom('r-01', { prevTop: 5, top: 6, total: 6, letters: [note('m-06')] })] }));
    expect(requests).toEqual([]);
    expect(useWorksStore.getState().entries[0]?.map.messages.map((message) => message.id)).toEqual(['m-05', 'm-06']);

    // Событие 9 при версии окна 7: пропущено 8, окно перечитывает держимое.
    bridge.emit('rooms.mail', makeMailEvent({ version: 9, prevVersion: 8, rooms: [makeMailRoom('r-01', { prevTop: 6, top: 7, total: 7, letters: [note('m-07')] })] }));
    await vi.waitFor(() => expect(requests).toEqual([undefined]));
    dispose();
  });
});

describe('useWorksStore: снимок без писем (спека rooms.mail 6.9)', () => {
  const letter = (seq: number, patch: Partial<Message> = {}): Message => note(`m-${seq}`, patch);
  function note(id: string, patch: Partial<Message> = {}): Message {
    return makeLetter(id, { roomId: 'r-01', to: [], from: 's-01', readBy: { human: 'x' }, ...patch });
  }
  /** Снимок без писем: в `r-01` — `total` писем; держимые окном письма в нём — `held`. */
  const bare = (total: number, held: Message[] = [], version = 5): WindowWorkEntry => ({
    ...withCompactMail(
      makeWork('w-01', { rooms: [makeRoom('r-01', 'К')] }),
      makeCompactMail({ rooms: { 'r-01': makeRoomNumbers({ total, top: total }) } }),
      held,
    ),
    version,
  });
  const heldIds = (): string[] => useWorksStore.getState().entries[0]!.map.messages.map((message) => message.id);
  const start = async (current: WindowWorkEntry) => {
    const bridge = createFakeBridge();
    bridge.emitStatus({ state: 'connected', hostVersion: '0.0.0-test', methods: null, features: [ROOMS_MAIL_FEATURE] });
    bridge.setHandler('works.list', () => snapshot(1, [current]));
    const dispose = useWorksStore.getState().init(bridge);
    await vi.waitFor(() => expect(useWorksStore.getState().loading).toBe(false));
    return { bridge, dispose };
  };

  it('письма, прочитанные страницей при открытии комнаты, переживают следующий снимок, а письма события — только открытой комнаты', async () => {
    const { bridge, dispose } = await start(bare(9));
    bridge.setHandler('context.messages', () => ({
      messages: [letter(8), letter(9)],
      page: { total: 9, returned: 2, complete: false, next: 'before:8', bytes: 1, cut: 0 },
    }));
    await openRoom(bridge, useWorksStore.getState().entries[0]!, 'r-01');
    expect(heldIds()).toEqual(['m-8', 'm-9']);

    bridge.emit('rooms.mail', makeMailEvent({ version: 6, prevVersion: 5, rooms: [makeMailRoom('r-01', { prevTop: 9, top: 10, total: 10, letters: [letter(10)] })] }));
    expect(heldIds()).toEqual(['m-8', 'm-9', 'm-10']);

    // Структурный снимок письма не несёт — окно переносит свои, а числа берёт новые.
    bridge.emit('works.changed', snapshot(2, [bare(10, [], 6)]));
    expect(heldIds()).toEqual(['m-8', 'm-9', 'm-10']);
    expect((useWorksStore.getState().entries[0]!.map.compact as ReturnType<typeof makeCompactMail>).rooms['r-01']?.total).toBe(10);
    dispose();
  });

  it('событие неоткрытой комнаты письмо не кладёт: числа обновились, лента пуста', async () => {
    const { bridge, dispose } = await start(bare(9));
    bridge.emit('rooms.mail', makeMailEvent({ version: 6, prevVersion: 5, rooms: [makeMailRoom('r-01', { prevTop: 9, top: 10, total: 10, letters: [letter(10)] })] }));
    expect(heldIds()).toEqual([]);
    expect((useWorksStore.getState().entries[0]!.map.compact as ReturnType<typeof makeCompactMail>).rooms['r-01']).toMatchObject({ total: 10, top: 10 });
    dispose();
  });

  // Склеенное или урезанное событие несёт письма человеку и `reread`: открытая комната, что до него ничего не держала, получила бы
  // от `withMail` только эти письма и осталась бы с дырой между ними — страницу открытия она больше не читает (дыра после итогового ревью).
  describe('склеенное событие и открытая пустая комната', () => {
    const room = '/tmp/proj\u0000w-01\u0000r-01';
    const mail = '/tmp/proj\u0000w-01\u0000';
    const toHuman = (seq: number, patch: Partial<Message> = {}): Message => letter(seq, { to: ['human'], readBy: {}, ...patch });
    const direct = (seq: number): Message => toHuman(seq, { roomId: null });
    const everything = (roomId: string | null): Message[] => [1, 2, 3, 4, 5, 6].map((seq) => letter(seq, { roomId, readBy: {} }));
    const answer = (messages: Message[]) => ({ messages, page: { total: messages.length, returned: messages.length, complete: true, next: null, bytes: 1, cut: 0 } });
    const reads = (bridge: ReturnType<typeof createFakeBridge>): Array<{ roomId: string | null; cursor?: string }> =>
      bridge.calls.filter((call) => call.method === 'context.messages').map((call) => call.params as { roomId: string | null; cursor?: string });
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
    const glued = (roomId: string | null, version = 6) =>
      makeMailEvent({
        version,
        prevVersion: 5,
        rooms: [makeMailRoom(roomId, { prevTop: 0, top: 6, total: 6, reread: true, letters: roomId === null ? [direct(3), direct(6)] : [toHuman(3), toHuman(6)] })],
        unread: { letters: 2, rooms: { [roomId ?? '']: 2 } },
      });

    it('открытая пустая комната после склеенного события дочитывает последнюю страницу', async () => {
      const { bridge, dispose } = await start(bare(6));
      useRoomPagesStore.setState({ opened: { [room]: true } });
      bridge.setHandler('context.messages', () => answer(everything('r-01')));

      bridge.emit('rooms.mail', glued('r-01'));
      // Событие положило только письма человеку; страница, что придёт следом, закрывает дыру между ними.
      expect(heldIds()).toEqual(['m-3', 'm-6']);
      await vi.waitFor(() => expect(heldIds()).toEqual(['m-1', 'm-2', 'm-3', 'm-4', 'm-5', 'm-6']));
      expect(reads(bridge)).toEqual([{ projectPath: '/tmp/proj', workId: 'w-01', roomId: 'r-01' }]);
      dispose();
    });

    it('то же у устаревшего события: снимок версии события вышел раньше', async () => {
      const { bridge, dispose } = await start(bare(6, [], 6));
      useRoomPagesStore.setState({ opened: { [room]: true } });
      bridge.setHandler('context.messages', () => answer(everything('r-01')));

      bridge.emit('rooms.mail', glued('r-01', 6));
      await vi.waitFor(() => expect(heldIds()).toEqual(['m-1', 'm-2', 'm-3', 'm-4', 'm-5', 'm-6']));
      expect(reads(bridge)).toHaveLength(1);
      dispose();
    });

    it('открытый Mail без писем после склеенного события дочитывает последнюю страницу', async () => {
      const { bridge, dispose } = await start(bare(6));
      useRoomPagesStore.setState({ opened: { [mail]: true } });
      bridge.setHandler('context.messages', () => answer(everything(null)));

      bridge.emit('rooms.mail', glued(null));
      expect(heldIds()).toEqual(['m-3', 'm-6']);
      await vi.waitFor(() => expect(heldIds()).toEqual(['m-1', 'm-2', 'm-3', 'm-4', 'm-5', 'm-6']));
      expect(reads(bridge)).toEqual([{ projectPath: '/tmp/proj', workId: 'w-01', roomId: null }]);
      dispose();
    });

    it('неоткрытая комната со склеенным событием страниц не читает', async () => {
      const { bridge, dispose } = await start(bare(6));
      bridge.setHandler('context.messages', () => answer(everything('r-01')));

      bridge.emit('rooms.mail', glued('r-01'));
      bridge.emit('rooms.mail', { ...glued(null, 7), prevVersion: 6 });
      await settle();

      expect(heldIds()).toEqual([]);
      expect(reads(bridge)).toEqual([]);
      dispose();
    });

    // Урезанная комната несёт больше ~250 КиБ писем, то есть не меньше четырёх страниц: одной страницы открытия не хватает, и между
    // письмами человеку (`m-2`, `m-30`) и страницей остаётся дыра. Окно читает вниз до наименьшего письма, что событие положило.
    describe('пачка больше страницы', () => {
      const fat = (seq: number, roomId: string): Message => letter(seq, { roomId, readBy: {}, text: 'x'.repeat(8 * 1024) });
      const batch = Array.from({ length: 30 }, (_, at) => fat(at + 1, 'r-01'));
      const cut = (version: number, prevVersion: number) =>
        makeMailEvent({
          version,
          prevVersion,
          rooms: [makeMailRoom('r-01', { prevTop: 0, top: 30, total: 30, reread: true, letters: [toHuman(2), toHuman(30)] })],
          unread: { letters: 2, rooms: { 'r-01': 2 } },
        });
      const heldFrom = (first: number, last: number): string[] => Array.from({ length: last - first + 1 }, (_, at) => `m-${first + at}`);
      /**
       * Страницы хоста, от новых писем к старым: `cuts` — сколько писем в каждой (хост режет страницу по байтам, поэтому они не равны),
       * курсор `before:N` ведёт к следующей. Страница, которой нет в `cuts`, — ошибка: окно читает глубже, чем нужно.
       */
      const paged = (all: Message[], cuts: number[]) => {
        const newestFirst = [...all].reverse();
        const pages = new Map<string | undefined, ReturnType<typeof answer>['page'] & { messages: Message[] }>();
        let from = 0;
        let cursor: string | undefined;
        for (const size of cuts) {
          const slice = newestFirst.slice(from, from + size);
          from += size;
          const next = from < newestFirst.length ? `before:${slice[slice.length - 1]!.id.slice('m-'.length)}` : null;
          pages.set(cursor, { messages: [...slice].reverse(), total: all.length, returned: slice.length, complete: next === null, next, bytes: 1, cut: 0 });
          cursor = next ?? undefined;
        }
        return (params: { cursor?: string }) => {
          const found = pages.get(params.cursor);
          if (found === undefined) throw new Error(`unexpected page ${params.cursor ?? '(first)'}`);
          const { messages, ...page } = found;
          return { messages, page };
        };
      };
      const cursors = (bridge: ReturnType<typeof createFakeBridge>, roomId = 'r-01'): Array<string | undefined> =>
        reads(bridge)
          .filter((read) => read.roomId === roomId)
          .map((read) => read.cursor);
      // Страницы по 8, 8, 8 и 5 писем: последняя доходит ровно до `m-2`, письма ниже её не читаются.
      const serve = () => paged(batch, [8, 8, 8, 5]);

      it('открытая пустая комната: пачка больше страницы после урезанного события дочитывается целиком', async () => {
        const { bridge, dispose } = await start(bare(30));
        useRoomPagesStore.setState({ opened: { [room]: true } });
        bridge.setHandler('context.messages', serve());

        bridge.emit('rooms.mail', cut(6, 5));
        expect(heldIds()).toEqual(['m-2', 'm-30']);
        await vi.waitFor(() => expect(heldIds()).toEqual(heldFrom(2, 30)));
        expect(cursors(bridge)).toEqual([undefined, 'before:23', 'before:15', 'before:7']);
        dispose();
      });

      it('то же у устаревшего события: снимок версии события вышел раньше', async () => {
        const { bridge, dispose } = await start(bare(30, [], 6));
        useRoomPagesStore.setState({ opened: { [room]: true } });
        bridge.setHandler('context.messages', serve());

        bridge.emit('rooms.mail', cut(6, 5));
        await vi.waitFor(() => expect(heldIds()).toEqual(heldFrom(2, 30)));
        expect(cursors(bridge)).toEqual([undefined, 'before:23', 'before:15', 'before:7']);
        dispose();
      });

      it('то же на пути разрыва: prevVersion выше версии окна', async () => {
        const { bridge, dispose } = await start(bare(30));
        useRoomPagesStore.setState({ opened: { [room]: true } });
        bridge.setHandler('context.messages', serve());

        bridge.emit('rooms.mail', cut(9, 8));
        await vi.waitFor(() => expect(heldIds()).toEqual(heldFrom(2, 30)));
        expect(cursors(bridge)).toEqual([undefined, 'before:23', 'before:15', 'before:7']);
        dispose();
      });

      it('то же на пути разрыва: версия окна неизвестна', async () => {
        const unversioned = bare(30);
        delete unversioned.version;
        const { bridge, dispose } = await start(unversioned);
        useRoomPagesStore.setState({ opened: { [room]: true } });
        bridge.setHandler('context.messages', serve());

        bridge.emit('rooms.mail', cut(6, 5));
        await vi.waitFor(() => expect(heldIds()).toEqual(heldFrom(2, 30)));
        expect(cursors(bridge)).toEqual([undefined, 'before:23', 'before:15', 'before:7']);
        dispose();
      });

      it('на пути разрыва держимая комната перечитывается тоже: починка и чтение открытой комнаты идут вместе', async () => {
        const other = '/tmp/proj\u0000w-01\u0000r-02';
        const sibling = [fat(31, 'r-02'), fat(32, 'r-02')];
        const two = (held: Message[]): WindowWorkEntry => ({
          ...withCompactMail(
            makeWork('w-01', { rooms: [makeRoom('r-01', 'К'), makeRoom('r-02', 'Л')] }),
            makeCompactMail({ rooms: { 'r-01': makeRoomNumbers({ total: 30, top: 30 }), 'r-02': makeRoomNumbers({ total: 2, top: 32 }) } }),
            held,
          ),
          version: 5,
        });
        // Снимок без писем (иначе первый снимок подключения сам починил бы держимое); письма r-02 окно получило позже.
        const { bridge, dispose } = await start(two([]));
        useWorksStore.setState({ entries: [two(sibling)] });
        useRoomPagesStore.setState({ opened: { [room]: true, [other]: true } });
        const first = serve();
        bridge.setHandler('context.messages', (params) => (params.roomId === 'r-02' ? answer(sibling) : first(params)));

        bridge.emit('rooms.mail', cut(9, 8));
        await vi.waitFor(() => expect(heldIds()).toEqual([...heldFrom(2, 30), 'm-31', 'm-32']));
        expect(cursors(bridge, 'r-02')).toEqual([undefined]);
        expect(cursors(bridge, 'r-01')).toEqual([undefined, 'before:23', 'before:15', 'before:7']);
        dispose();
      });
    });
  });

  it('держится не больше 300 писем на комнату; подгруженная раньше история остаётся', async () => {
    const many = Array.from({ length: 450 }, (_, index) => letter(index + 1));
    const { bridge, dispose } = await start(bare(450));
    useRoomPagesStore.setState({ opened: { '/tmp/proj\u0000w-01\u0000r-01': true } });
    useWorksStore.setState({ entries: [bare(450, many)] });
    bridge.emit('works.changed', snapshot(2, [bare(450, [], 6)]));
    expect(heldIds()).toHaveLength(300);
    expect(heldIds()[0]).toBe('m-151');

    // Человек подгрузил историю до m-101: следующий снимок её не срезает.
    useWorksStore.setState({ entries: [bare(450, many)] });
    useRoomPagesStore.setState({ chains: { '/tmp/proj\u0000w-01\u0000r-01': { next: 'before:101', done: false } } });
    bridge.emit('works.changed', snapshot(3, [bare(450, [], 7)]));
    expect(heldIds()).toHaveLength(350);
    expect(heldIds()[0]).toBe('m-101');
    dispose();
  });

  it('событиями комната не растёт больше 300 писем, подгруженное раньше остаётся', async () => {
    const room = '/tmp/proj\u0000w-01\u0000r-01';
    const { bridge, dispose } = await start(bare(300));
    useRoomPagesStore.setState({ opened: { [room]: true } });
    useWorksStore.setState({ entries: [bare(300, Array.from({ length: 300 }, (_, index) => letter(index + 1)))] });
    // Пять событий по десять писем (письма только пишутся, снимков между ними нет): окно держит 300 новейших.
    let version = 5;
    const write = (from: number, to: number): void => {
      version += 1;
      bridge.emit(
        'rooms.mail',
        makeMailEvent({
          version,
          prevVersion: version - 1,
          rooms: [makeMailRoom('r-01', { prevTop: from - 1, top: to, total: to, letters: Array.from({ length: to - from + 1 }, (_, index) => letter(from + index)) })],
        }),
      );
    };
    for (let from = 301; from <= 350; from += 10) write(from, from + 9);
    expect(heldIds()).toHaveLength(300);
    expect(heldIds()[0]).toBe('m-51');
    expect(heldIds().at(-1)).toBe('m-350');

    // Человек подгрузил историю до m-31: новое письмо её не срезает.
    useRoomPagesStore.setState({ chains: { [room]: { next: 'before:31', done: false } } });
    useWorksStore.setState({ entries: [bare(350, Array.from({ length: 320 }, (_, index) => letter(index + 31)), version)] });
    write(351, 351);
    expect(heldIds()).toHaveLength(321);
    expect(heldIds()[0]).toBe('m-31');
    dispose();
  });

  // Построение карты на хосте может длиться дольше пачки писем (находка I2): снимок версии 6 выходит после события версии 7,
  // и числа с кандидатами в упоминания окно оставляет от события, а структуру (комнаты) берёт из снимка.
  it('снимок старее применённого события не откатывает числа и кандидатов', async () => {
    const { bridge, dispose } = await start(bare(9, [], 5));
    const mention = letter(11, { to: ['human'], text: '@human, look', readBy: {} });
    bridge.emit(
      'rooms.mail',
      makeMailEvent({
        version: 7,
        prevVersion: 5,
        rooms: [makeMailRoom('r-01', { prevTop: 9, top: 11, total: 11, letters: [letter(10), mention] })],
        unread: { letters: 0, rooms: { 'r-01': 1 } },
        mentionCandidates: [mention],
      }),
    );
    const numbers = (): ReturnType<typeof makeCompactMail> => useWorksStore.getState().entries[0]!.map.compact as ReturnType<typeof makeCompactMail>;
    expect(numbers().rooms['r-01']).toMatchObject({ total: 11, top: 11, unread: 1 });
    expect(numbers().mentionCandidates.map((message) => message.id)).toEqual(['m-11']);

    // Снимок версии 6 — собран до письма m-11 и вышел позже события; в нём новая комната.
    const older = bare(9, [], 6);
    const withRoom: WindowWorkEntry = { ...older, map: { ...older.map, rooms: [...older.map.rooms, makeRoom('r-02', 'Вторая')] } };
    bridge.emit('works.changed', snapshot(2, [withRoom]));

    const entry = useWorksStore.getState().entries[0]!;
    expect(entry.map.rooms.map((room) => room.id)).toEqual(['r-01', 'r-02']);
    expect(numbers().rooms['r-01']).toMatchObject({ total: 11, top: 11, unread: 1 });
    expect(numbers().unread).toEqual({ letters: 0, rooms: { 'r-01': 1 } });
    expect(numbers().mentionCandidates.map((message) => message.id)).toEqual(['m-11']);

    // Снимок не старее держимой версии числа ставит как всегда.
    bridge.emit('works.changed', snapshot(3, [bare(12, [], 8)]));
    expect(numbers().rooms['r-01']).toMatchObject({ total: 12, top: 12 });
    expect(numbers().mentionCandidates).toEqual([]);
    dispose();
  });

  describe('после переподключения', () => {
    const page = (messages: Message[]) => ({ messages, page: { total: 10, returned: messages.length, complete: true, next: null, bytes: 1, cut: 0 } });
    /** Работа, в которой окно ничего не держит: её после переподключения перечитывать нечем. */
    const quiet = (version = 5): WindowWorkEntry => ({
      ...withCompactMail(makeWork('w-02', { rooms: [makeRoom('r-01', 'К')] }), makeCompactMail({ rooms: { 'r-01': makeRoomNumbers({ total: 3, top: 3 }) } })),
      version,
    });
    const connect = (answer: WorksSnapshot, reads: unknown[]) => {
      const bridge = createFakeBridge();
      bridge.emitStatus({ state: 'connected', hostVersion: '0.0.0-test', methods: null, features: [ROOMS_MAIL_FEATURE] });
      bridge.setHandler('works.list', () => answer);
      bridge.setHandler('context.messages', (params) => {
        reads.push(params);
        return page([letter(8), letter(9), letter(10)]);
      });
      return { bridge, dispose: useWorksStore.getState().init(bridge) };
    };

    it('после переподключения держимые комнаты перечитываются один раз', async () => {
      const room = '/tmp/proj\u0000w-01\u0000r-01';
      const first = await start(bare(9));
      useRoomPagesStore.setState({ opened: { [room]: true } });
      // Окно держит открытую комнату и Mail первой работы; письма, написанные при обрыве связи, в них не попали.
      useWorksStore.setState({ entries: [bare(9, [letter(8), letter(9), letter(3, { roomId: null, to: ['human'] })]), quiet()] });
      first.dispose();

      const reads: Array<{ workId: string; roomId: string | null }> = [];
      const { bridge, dispose } = connect(snapshot(1, [bare(10, [], 6), quiet(6)]), reads);
      await vi.waitFor(() => expect(reads).toHaveLength(2));
      await flush();
      expect(reads.map((read) => `${read.workId}/${read.roomId}`).sort()).toEqual(['w-01/null', 'w-01/r-01']);
      expect(heldIds()).toContain('m-10');

      // Дальше — обычные снимки: новой починки они не вызывают.
      bridge.emit('works.changed', snapshot(2, [bare(10, [], 7), quiet(7)]));
      await flush();
      await flush();
      expect(reads).toHaveLength(2);
      dispose();
    });

    it('работа без держимых писем починки не получает; первый снимок v1 тоже', async () => {
      useWorksStore.setState({ entries: [quiet(), entry([note('m-05')], 5, 5, 5)] });
      const reads: unknown[] = [];
      const { dispose } = connect(snapshot(1, [quiet(6), entry([note('m-05')], 5, 5, 6)]), reads);
      await vi.waitFor(() => expect(useWorksStore.getState().ready).toBe(true));
      await flush();
      expect(reads).toEqual([]);
      dispose();
    });
  });

  it('комната, которой нет в новом снимке, свои письма уносит', async () => {
    const { bridge, dispose } = await start(bare(2));
    useWorksStore.setState({ entries: [bare(2, [letter(1), letter(2)])] });
    const without: WindowWorkEntry = { ...bare(0, [], 6), map: { ...bare(0).map, rooms: [] } };
    bridge.emit('works.changed', snapshot(2, [without]));
    expect(heldIds()).toEqual([]);
    dispose();
  });

  it('прежний хост (compact версии 1): письма снимка на месте, ушедшие из хвоста прочитанные остаются, как раньше', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('works.list', () => snapshot(1, [entry([note('m-03'), note('m-04')], 4, 3)]));
    const dispose = useWorksStore.getState().init(bridge);
    await flush();
    bridge.emit('works.changed', snapshot(2, [entry([note('m-04'), note('m-05')], 5, 4)]));
    expect(heldIds()).toEqual(['m-03', 'm-04', 'm-05']);
    dispose();
  });
});
