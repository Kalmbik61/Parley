import { describe, expect, it } from 'vitest';
import {
  PAGE_MAX_BYTES,
  PAGE_MIN_BYTES,
  PageError,
  capStrings,
  clampPageBytes,
  compactWorkMap,
  listPage,
  mapTopology,
  messagePage,
  pageBySeq,
  parseCursor,
  seqOf,
  textPage,
  viewBytes,
} from './context-pages.js';
import { addMessage, addSession } from './map.js';
import { addRoom } from './rooms.js';
import { HUMAN, type Message, type WorkMap } from './types.js';

const emptyMap = (): WorkMap => ({
  schemaVersion: 2,
  work: { id: 'w-0001', title: 'Работа', goal: 'Цель', status: 'active', createdAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z' },
  sessions: [],
  messages: [],
  rooms: [],
});

/** Карта с двумя сессиями и комнатой, куда дописывают письма. */
function baseMap(): WorkMap {
  const map = emptyMap();
  addSession(map, { provider: 'claude', label: 'план', task: 'Спланировать' });
  addSession(map, { provider: 'codex', label: 'код', task: 'Написать', parent: 's-01' });
  addRoom(map, { title: 'Обсуждение', creator: HUMAN, members: ['s-01', 's-02'], lead: 's-01' });
  return map;
}

function fill(map: WorkMap, count: number, textLength: number, init: Partial<Parameters<typeof addMessage>[1]> = {}): void {
  for (let i = 0; i < count; i += 1) {
    addMessage(map, { from: 's-02', to: [], roomId: 'r-01', text: `${i}:`.padEnd(textLength, 'я'), ...init });
  }
}

const frameBytes = (value: unknown): number => Buffer.byteLength(`${JSON.stringify(value)}\n`, 'utf8');
const ids = (messages: readonly { id: string }[]): string[] => messages.map((message) => message.id);

describe('курсор', () => {
  it('разбирается и называет ошибку понятно', () => {
    expect(parseCursor(undefined)).toBeNull();
    expect(parseCursor('before:12')).toEqual({ dir: 'before', seq: 12 });
    expect(parseCursor('after:3')).toEqual({ dir: 'after', seq: 3 });
    for (const bad of ['12', 'before:', 'before:-1', 'sideways:4', 5]) {
      expect(() => parseCursor(bad)).toThrow(PageError);
    }
  });

  it('размер страницы из запроса зажат между пределами', () => {
    expect(clampPageBytes(undefined)).toBe(64 * 1024);
    expect(clampPageBytes(1)).toBe(PAGE_MIN_BYTES);
    expect(clampPageBytes(10 ** 9)).toBe(PAGE_MAX_BYTES);
    expect(clampPageBytes(Number.NaN)).toBe(64 * 1024);
  });
});

describe('страницы по номеру записи', () => {
  const numbered = (count: number): number[] => Array.from({ length: count }, (_, index) => index + 1);
  const read = (items: number[], options: Partial<Parameters<typeof pageBySeq<number, number>>[1]> = {}) =>
    pageBySeq(items, { seq: (n) => n, view: (n) => n, ...options });

  it('без курсора — самые новые, по возрастанию; before идёт к старым и дочитывает до конца без повторов', () => {
    const items = numbered(25);
    const seen: number[] = [];
    let cursor = null as ReturnType<typeof parseCursor>;
    for (let guard = 0; guard < 50; guard += 1) {
      const { items: got, page } = read(items, { maxItems: 4, cursor });
      seen.unshift(...got);
      expect(got).toEqual([...got].sort((a, b) => a - b));
      if (page.complete) {
        expect(page.next).toBeNull();
        break;
      }
      cursor = parseCursor(page.next);
    }
    expect(seen).toEqual(items);
  });

  it('after идёт вперёд от номера: дописанное в конец между чтениями попадает в следующий запрос без пропусков', () => {
    const items = numbered(10);
    const first = read(items, { cursor: parseCursor('after:0'), maxItems: 4 });
    expect(first.items).toEqual([1, 2, 3, 4]);
    expect(first.page.complete).toBe(false);
    items.push(11, 12); // между запросами в карту дописали письма
    const second = read(items, { cursor: parseCursor(first.page.next), maxItems: 100 });
    expect(second.items).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);
    expect(second.page.complete).toBe(true);
  });

  it('дописывание при чтении назад ничего не сдвигает: старые страницы те же, новые читаются after', () => {
    const items = numbered(12);
    const tail = read(items, { maxItems: 5 });
    expect(tail.items).toEqual([8, 9, 10, 11, 12]);
    items.push(13, 14, 15);
    const older = read(items, { cursor: parseCursor(tail.page.next), maxItems: 5 });
    expect(older.items).toEqual([3, 4, 5, 6, 7]);
    const newer = read(items, { cursor: parseCursor('after:12') });
    expect(newer.items).toEqual([13, 14, 15]);
  });

  it('потолок в байтах: страница не больше заявленного, следующий курсор продолжает с того же места', () => {
    const items = Array.from({ length: 200 }, (_, index) => ({ n: index + 1, text: 'я'.repeat(100) }));
    const options = { seq: (item: { n: number }) => item.n, view: (item: { n: number; text: string }) => item, maxBytes: 4096 };
    const seen: number[] = [];
    let cursor = null as ReturnType<typeof parseCursor>;
    for (let guard = 0; guard < 500; guard += 1) {
      const { items: got, page } = pageBySeq(items, { ...options, cursor });
      expect(page.bytes).toBeLessThanOrEqual(4096);
      expect(viewBytes(got)).toBeLessThan(4096 + 64);
      seen.unshift(...got.map((row) => row.n));
      if (page.complete) break;
      cursor = parseCursor(page.next);
    }
    expect(seen).toEqual(items.map((row) => row.n));
  });

  it('запись, которая одна не влезает, сокращается и считается в cut; без сокращения — ошибка, а не обрезка молча', () => {
    const items = [{ n: 1, text: 'x'.repeat(10_000) }];
    const base = { seq: (item: { n: number }) => item.n, view: (item: { n: number; text: string }) => item, maxBytes: 2048 };
    expect(() => pageBySeq(items, base)).toThrow(/does not fit/);
    const { items: got, page } = pageBySeq(items, {
      ...base,
      shrink: (view, limit) => ({ ...view, text: view.text.slice(0, limit - 200) }),
    });
    expect(got[0]?.text.length).toBeLessThan(2048);
    expect(page.cut).toBe(1);
  });

  it('total: известен по длине выборки, задан явно или неизвестен (null) — полнота определяется курсором, а не total', () => {
    const items = numbered(10);
    expect(read(items, { maxItems: 3 }).page).toMatchObject({ total: 10, complete: false });
    expect(read(items, { maxItems: 3, total: 40 }).page.total).toBe(40);
    const unknown = read(items, { maxItems: 3, total: null }).page;
    expect(unknown.total).toBeNull();
    expect(unknown.complete).toBe(false);
    expect(unknown.next).toBe('before:8');
    expect(read(items, { total: null }).page).toMatchObject({ total: null, complete: true, next: null });
  });

  it('пустая выборка и курсор за краем — пустая полная страница', () => {
    expect(read([]).page).toMatchObject({ returned: 0, complete: true, next: null });
    expect(read(numbered(3), { cursor: parseCursor('before:1') }).page).toMatchObject({ returned: 0, complete: true, next: null });
    expect(read(numbered(3), { cursor: parseCursor('after:3') }).page).toMatchObject({ returned: 0, complete: true, next: null });
  });

  it('listPage: позиция в списке — номер; история и артефакты читаются теми же курсорами', () => {
    const history = ['a', 'b', 'c', 'd', 'e'];
    const first = listPage(history, { view: (item) => item, maxItems: 2 });
    expect(first.items).toEqual(['d', 'e']);
    const second = listPage(history, { view: (item) => item, maxItems: 2, cursor: parseCursor(first.page.next) });
    expect(second.items).toEqual(['b', 'c']);
    const third = listPage(history, { view: (item) => item, maxItems: 2, cursor: parseCursor(second.page.next) });
    expect(third.items).toEqual(['a']);
    expect(third.page.complete).toBe(true);
  });
});

describe('страницы писем', () => {
  it('письма комнаты идут по номеру m-NN, чужие комнаты и прямые письма не попадают; kind отбирает решения', () => {
    const map = baseMap();
    addRoom(map, { title: 'Другая', creator: HUMAN, members: ['s-02'], lead: 's-02' });
    fill(map, 6, 20);
    addMessage(map, { from: 's-01', to: ['s-02'], text: 'прямое' });
    addMessage(map, { from: 's-01', to: [], roomId: 'r-02', text: 'в другой' });
    addMessage(map, { from: 's-01', to: [], roomId: 'r-01', text: 'решили', kind: 'decision' });

    const room = messagePage(map, { roomId: 'r-01', view: (message) => message });
    expect(room.messages.every((message) => message.roomId === 'r-01')).toBe(true);
    expect(room.page).toMatchObject({ total: 7, complete: true });
    expect(ids(room.messages)).toEqual(['m-01', 'm-02', 'm-03', 'm-04', 'm-05', 'm-06', 'm-09']);

    const decisions = messagePage(map, { roomId: 'r-01', kind: 'decision', view: (message) => message });
    expect(ids(decisions.messages)).toEqual(['m-09']);
    expect(decisions.page.total).toBe(1);

    const direct = messagePage(map, { roomId: null, view: (message) => message });
    expect(direct.messages.map((message) => message.text)).toEqual(['прямое']);
  });

  it('письмо длиннее страницы сокращается с пометкой и полным размером, а не обрывается молча', () => {
    const map = baseMap();
    addMessage(map, { from: 's-01', to: [], roomId: 'r-01', text: 'ы'.repeat(50_000) });
    const { messages, page } = messagePage(map, { roomId: 'r-01', maxBytes: 4096, view: (message) => message });
    expect(page.cut).toBe(1);
    expect(page.complete).toBe(true);
    const only = messages[0] as Message;
    expect(only.textBytes).toBe(100_000);
    expect(only.text).toContain('cut: ');
    expect(viewBytes(messages)).toBeLessThan(4096 + 64);
  });

  it('чтение страницами при дописывании: каждое письмо ровно один раз, историю не теряем', () => {
    const map = baseMap();
    fill(map, 60, 300);
    const seen: string[] = [];
    let cursor = null as ReturnType<typeof parseCursor>;
    for (let guard = 0; guard < 100; guard += 1) {
      const { messages, page } = messagePage(map, { roomId: 'r-01', maxBytes: 4096, cursor, view: (message) => message });
      seen.unshift(...ids(messages));
      // Между страницами комната живёт: пишут новые письма.
      fill(map, 3, 300);
      if (page.complete) break;
      cursor = parseCursor(page.next);
    }
    const original = Array.from({ length: 60 }, (_, index) => `m-${String(index + 1).padStart(2, '0')}`);
    expect(seen).toEqual(original);
    expect(new Set(seen).size).toBe(seen.length);
    // Дописанное после чтения забирается курсором after без повторов.
    const newer = messagePage(map, { roomId: 'r-01', cursor: parseCursor('after:60'), maxItems: 500, view: (message) => message });
    expect(newer.messages.length).toBe(map.messages.length - 60);
    expect(newer.messages.every((message) => seqOf(message.id, 'm-') > 60)).toBe(true);
  });
});

describe('страницы текста', () => {
  const collect = (text: string, maxBytes: number): string => {
    let out = '';
    let cursor: string | undefined;
    for (let guard = 0; guard < 5000; guard += 1) {
      const page = textPage(text, cursor, maxBytes);
      expect(JSON.stringify(page.text).length).toBeLessThanOrEqual(maxBytes);
      out += page.text;
      if (page.complete) {
        expect(page.next).toBeNull();
        return out;
      }
      cursor = page.next as string;
    }
    throw new Error('the text did not end');
  };

  it('куски склеиваются в исходный текст: многобайтные знаки и управляющие символы не рвутся', () => {
    const text = `${'Привет, мир! 😀 '.repeat(500)}${'\u0000\n\t'.repeat(300)}конец`;
    expect(collect(text, 1024)).toBe(text);
  });

  it('полный размер и хеш названы; пустой текст — одна полная страница', () => {
    const page = textPage('abc', undefined, 1024);
    expect(page).toMatchObject({ text: 'abc', offset: 0, bytes: 3, totalBytes: 3, complete: true, next: null });
    expect(page.sha256).toMatch(/^[0-9a-f]{12}$/);
    expect(textPage('', undefined, 1024)).toMatchObject({ text: '', complete: true });
  });

  it('текст сменился между страницами — отказ, а не склейка кусков разных текстов', () => {
    const first = textPage('a'.repeat(5000), undefined, 1024);
    expect(first.complete).toBe(false);
    expect(() => textPage(`${'a'.repeat(5000)}!`, first.next, 1024)).toThrow(/changed/);
    expect(() => textPage('a'.repeat(5000), 'offset:abc', 1024)).toThrow(PageError);
    expect(() => textPage('a', 'offset:99:000000000000', 1024)).toThrow(PageError);
  });
});

describe('capStrings', () => {
  it('режет длинные строки с пометкой, записывает путь и полный размер, нетронутые ветки не копирует', () => {
    const untouched = { a: 'коротко', list: [1, 2, 3] };
    const input = { big: 'я'.repeat(5000), nested: { items: ['ok', 'x'.repeat(5000)] }, untouched };
    const cuts: { path: string; bytes: number }[] = [];
    const out = capStrings(input, 1000, '', cuts);
    expect(out.big.length).toBeLessThan(600);
    expect(out.big).toContain('cut: ');
    expect(out.nested.items[0]).toBe('ok');
    expect(out.untouched).toBe(untouched);
    expect(cuts).toEqual([
      { path: 'big', bytes: 10_000 },
      { path: 'nested.items[1]', bytes: 5000 },
    ]);
    expect(input.big.length).toBe(5000);
  });
});

describe('карта окна', () => {
  it('не меняет исходную карту и сохраняет форму WorkMap', () => {
    const map = baseMap();
    fill(map, 30, 40);
    const before = JSON.stringify(map);
    const compact = compactWorkMap(map, { messageBytes: 1024 * 1024 });
    expect(JSON.stringify(map)).toBe(before);
    expect(compact.schemaVersion).toBe(2);
    expect(compact.sessions.map((session) => session.id)).toEqual(['s-01', 's-02']);
    expect(compact.rooms).toHaveLength(1);
    expect(compact.compact).toMatchObject({ version: 1, messages: { total: 30, included: 30, latestId: 'm-30' } });
  });

  it('хвост комнаты и непрочитанное человеком в окне, остальное за окном; точные счётчики названы', () => {
    const map = baseMap();
    fill(map, 300, 30);
    // Старые письма человек уже прочитал, кроме трёх.
    for (const message of map.messages) message.readBy[HUMAN] = '2026-10-05T00:00:00.000Z';
    for (const id of ['m-02', 'm-03', 'm-04']) delete (map.messages.find((message) => message.id === id) as Message).readBy[HUMAN];
    const compact = compactWorkMap(map, { messageBytes: 1024 * 1024, recentPerRoom: 20 });
    const included = ids(compact.messages);
    expect(included).toContain('m-300');
    expect(included).toContain('m-281');
    expect(included).not.toContain('m-100');
    expect(included).toEqual(expect.arrayContaining(['m-02', 'm-03', 'm-04']));
    expect(included).toEqual([...included].sort((a, b) => seqOf(a, 'm-') - seqOf(b, 'm-')));
    // Хвост без дыр — последние 20 (m-281…m-300); непрочитанные m-02…m-04 лежат отдельно, от хвоста их отделяет дыра.
    expect(compact.compact?.messages.rooms['r-01']).toEqual({ total: 300, included: 23, tailFrom: 281 });
    expect(compact.compact?.unread).toEqual({ letters: 0, rooms: { 'r-01': 3 } });
  });

  it('подлинник цитаты берётся из той же комнаты, чужой id не тянется', () => {
    const map = baseMap();
    addRoom(map, { title: 'Другая', creator: HUMAN, members: ['s-02'], lead: 's-02' });
    addMessage(map, { from: HUMAN, to: [], roomId: 'r-01', text: 'вопрос' }); // m-01
    addMessage(map, { from: HUMAN, to: [], roomId: 'r-02', text: 'чужое' }); // m-02
    fill(map, 5, 10, { roomId: 'r-02' });
    fill(map, 10, 10);
    addMessage(map, { from: 's-01', to: [], roomId: 'r-01', text: 'ответ', replyTo: 'm-01' });
    addMessage(map, { from: 's-01', to: [], roomId: 'r-01', text: 'не туда', replyTo: 'm-02' });
    const compact = compactWorkMap(map, { messageBytes: 1024 * 1024, recentPerRoom: 2 });
    expect(ids(compact.messages)).toContain('m-01');
    expect(ids(compact.messages)).not.toContain('m-02');
  });

  it('воспроизведение 1 аудита: 900 писем по 10 000 знаков — карта окна далеко ниже 8 МиБ, исходная выше', () => {
    const map = baseMap();
    fill(map, 900, 10_000);
    expect(frameBytes({ entries: [{ projectPath: '/p', map }] })).toBeGreaterThan(8 * 1024 * 1024);
    const compact = compactWorkMap(map, { messageBytes: 512 * 1024 });
    const frame = frameBytes({ entries: [{ projectPath: '/p', map: compact }], branches: {} });
    expect(frame).toBeLessThan(1024 * 1024);
    expect(compact.messages.length).toBeGreaterThan(0);
    expect(compact.compact?.messages.total).toBe(900);
    expect(compact.compact?.messages.latestId).toBe('m-900');
  });

  it('воспроизведение 2 аудита: 2 100 решений по 4 000 знаков в штатной карте — окно в пределах бюджета', () => {
    const map = baseMap();
    fill(map, 2100, 4000, { kind: 'decision' });
    expect(frameBytes({ entries: [{ projectPath: '/p', map }] })).toBeGreaterThan(8 * 1024 * 1024);
    const compact = compactWorkMap(map, { messageBytes: 512 * 1024 });
    expect(frameBytes({ entries: [{ projectPath: '/p', map: compact }], branches: {} })).toBeLessThan(1024 * 1024);
  });

  it('письмо в мегабайт сокращается с пометкой и полным размером; пути обрезанного названы в compact.cut', () => {
    const map = baseMap();
    addMessage(map, { from: 's-02', to: [], roomId: 'r-01', text: 'ё'.repeat(1_000_000) });
    map.sessions[0]!.task = 'з'.repeat(200_000);
    map.work.goal = 'г'.repeat(100_000);
    const compact = compactWorkMap(map, { messageBytes: 1024 * 1024 });
    const message = compact.messages[0] as Message;
    expect(message.textBytes).toBe(2_000_000);
    expect(message.text).toContain('cut: ');
    expect(compact.sessions[0]?.task).toContain('cut: ');
    expect(compact.work.goal).toContain('cut: ');
    expect(compact.compact?.cut.map((cut) => cut.path).sort()).toEqual(['messages.m-01.text', 'sessions.s-01.task', 'work.goal']);
    expect(compact.compact?.cut.find((cut) => cut.path === 'messages.m-01.text')?.bytes).toBe(2_000_000);
  });

  it('история сессии и артефакты обрезаны хвостом, число опущенных названо; внутренние очереди хоста не едут', () => {
    const map = baseMap();
    const session = map.sessions[0]!;
    for (let i = 0; i < 300; i += 1) session.history.push({ event: 'active', at: '2026-10-05T00:00:00.000Z' });
    for (let i = 0; i < 150; i += 1) session.artifacts.push({ kind: 'file', path: `a${i}.md` });
    map.decisionExports = [{ file: 'f', workId: 'w', roomId: 'r', proposalId: 'p', rev: 0, messageId: 'm', acceptedAt: 'x', kind: 'decision', snapshot: null, snapshotSha256: null, content: 'ж'.repeat(100_000), status: 'pending' }];
    map.planExports = [{ file: 'p.md', planId: 'pl-1', rev: 1, event: 'accepted', content: 'ж'.repeat(100_000), status: 'pending' }];
    const compact = compactWorkMap(map, { messageBytes: 1024 });
    expect(compact.sessions[0]?.history).toHaveLength(100);
    expect(compact.sessions[0]?.artifacts).toHaveLength(100);
    expect(compact.compact?.omitted).toMatchObject({ 'sessions.s-01.history': 201, 'sessions.s-01.artifacts': 50, decisionExports: 1 });
    expect(compact.decisionExports).toBeUndefined();
    expect(compact.planExports).toEqual([{ file: 'p.md', planId: 'pl-1', rev: 1, event: 'accepted', content: '', status: 'pending' }]);
    expect(frameBytes(compact)).toBeLessThan(64 * 1024);
  });

  it('бюджет писем 0 — только итоги и точные счётчики (архивная работа)', () => {
    const map = baseMap();
    fill(map, 50, 20);
    const compact = compactWorkMap(map, { messageBytes: 0 });
    expect(compact.messages).toEqual([]);
    expect(compact.compact?.messages).toMatchObject({ total: 50, included: 0 });
    expect(compact.compact?.unread.rooms['r-01']).toBe(50);
  });

  it('10 тыс. писем и несколько работ: суммарный кадр снимка в разы ниже 8 МиБ, задержка и размер измерены', () => {
    const maps = Array.from({ length: 4 }, (_, index) => {
      const map = baseMap();
      map.work.id = `w-000${index + 1}`;
      fill(map, 2500, 1500);
      return map;
    });
    const started = performance.now();
    const compacts = maps.map((map) => compactWorkMap(map, { messageBytes: 512 * 1024 }));
    const elapsed = performance.now() - started;
    const frame = frameBytes({ entries: compacts.map((map) => ({ projectPath: '/p', map })), branches: {} });
    const full = frameBytes({ entries: maps.map((map) => ({ projectPath: '/p', map })), branches: {} });
    expect(full).toBeGreaterThan(8 * 1024 * 1024);
    expect(frame).toBeLessThan(4 * 1024 * 1024);
    expect(elapsed).toBeLessThan(5000);
    for (const compact of compacts) expect(compact.compact?.messages.total).toBe(2500);
  });
});

describe('топология для агента', () => {
  it('размер не зависит от длины переписки; письма и история — счётчиками и курсорами', () => {
    const small = baseMap();
    fill(small, 5, 100);
    const big = baseMap();
    fill(big, 5000, 4000);
    const smallBytes = viewBytes(mapTopology(small, 's-01'));
    const bigTopology = mapTopology(big, 's-01');
    expect(viewBytes(bigTopology)).toBeLessThan(smallBytes + 600);
    expect(bigTopology.messages).toMatchObject({ total: 5000, latestId: 'm-5000' });
    expect(bigTopology.rooms[0]?.messages).toEqual({ total: 5000, latestId: 'm-5000', unreadForYou: 5000 });
    expect(JSON.stringify(bigTopology)).not.toContain('я'.repeat(100));
  });

  it('непрочитанное считается для вызывающей сессии, а не для всех', () => {
    const map = baseMap();
    addMessage(map, { from: 's-02', to: ['s-01'], text: 'прямое' });
    addMessage(map, { from: 's-02', to: [], roomId: 'r-01', text: 'в комнату' });
    addMessage(map, { from: 's-01', to: ['s-02'], text: 'туда' });
    expect(mapTopology(map, 's-01').messages.unreadForYou).toEqual({ total: 2, rooms: { 'r-01': 1 }, direct: 1 });
    expect(mapTopology(map, 's-02').messages.unreadForYou).toEqual({ total: 1, rooms: {}, direct: 1 });
    expect(mapTopology(map, null).messages.unreadForYou).toEqual({ total: 0, rooms: {}, direct: 0 });
  });

  it('архивная комната помечена archived: true, а у открытой поля нет; письма архивной непрочитанными не числятся', () => {
    const map = baseMap();
    addRoom(map, { title: 'Вторая', creator: HUMAN, members: ['s-02'] });
    addMessage(map, { from: 's-02', to: [], roomId: 'r-01', text: 'в комнату' });
    map.rooms[0]!.archivedAt = '2026-10-08T12:00:00.000Z';

    const topology = mapTopology(map, 's-01');

    expect(topology.rooms[0]?.archived).toBe(true);
    expect(topology.rooms[1]).not.toHaveProperty('archived');
    expect(topology.messages.unreadForYou).toEqual({ total: 0, rooms: {}, direct: 0 });
  });

  it('длинные задача, резюме и цель сокращены, полный размер назван в cut; статус и последнее событие на месте', () => {
    const map = baseMap();
    map.work.goal = 'ц'.repeat(5000);
    map.sessions[0]!.task = 'з'.repeat(5000);
    map.sessions[0]!.summary = 'р'.repeat(5000);
    map.sessions[0]!.history.push({ event: 'active', at: '2026-10-05T00:00:00.000Z' });
    const topology = mapTopology(map, 's-01');
    expect(topology.work.cut).toEqual({ goal: 10_000 });
    expect(topology.work.goal).toContain('cut: 10000 bytes in full');
    expect(topology.sessions[0]?.cut).toEqual({ task: 10_000, summary: 10_000 });
    expect(topology.sessions[0]).toMatchObject({ id: 's-01', lifecycle: 'pending', historyCount: 2, artifactCount: 0 });
    expect(topology.sessions[0]?.lastEvent?.event).toBe('active');
    expect(topology.sessions[1]?.cut).toBeUndefined();
  });

  it('комната: плейбук рецепта не виден, ждущее решение сокращено; в планах только действующие ревизии с хвостом журнала', () => {
    const map = baseMap();
    map.rooms[0]!.recipe = { id: 'project:x', name: 'X', playbook: 'SECRET PLAYBOOK' };
    map.rooms[0]!.proposal = { id: 'p-01', from: 's-01', text: 'р'.repeat(5000), rev: 1, at: '2026-10-05T00:00:00.000Z' };
    const logs = Array.from({ length: 10 }, (_, index) => ({ at: 'x', by: 's-01', status: 'in_progress' as const, note: String(index) }));
    const plan = (id: string, status: 'active' | 'completed') => ({
      id, roomId: 'r-01', mode: 'checklist' as const, status, rev: 1, goal: 'g', backlog: [],
      items: [{ id: 1, title: 't', owner: 's-02', scope: 's', after: [], criteria: [], verifier: null, status: 'in_progress' as const, evidence: null, note: null, log: logs }],
      acceptedAt: null, completedAt: null, cancelledAt: null, completionSummary: null,
    });
    map.plans = [plan('pl-1', 'completed'), plan('pl-2', 'active')];
    const topology = mapTopology(map, 's-01');
    expect(JSON.stringify(topology)).not.toContain('SECRET PLAYBOOK');
    expect(topology.rooms[0]?.recipe).toEqual({ id: 'project:x', name: 'X' });
    expect(topology.rooms[0]?.proposal?.cut).toEqual({ text: 10_000 });
    expect(topology.plans.map((row) => row.id)).toEqual(['pl-2']);
    expect(topology.plans[0]?.items[0]?.log).toHaveLength(3);
  });
});
