import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LETTER_PAGE_MAX_ITEMS,
  PAGE_MAX_BYTES,
  PAGE_MAX_ITEMS,
  PAGE_MIN_BYTES,
  PageError,
  WINDOW_MENTION_MAX_BYTES,
  WINDOW_TEXT_MAX,
  WINDOW_UNREAD_MAX,
  type LetterReader,
  capStrings,
  clampPageBytes,
  compactWorkMap as compactWorkMapOf,
  humanMentionCandidates,
  keepNewestWithin,
  listPage,
  mailWorkMap,
  mapTopology as mapTopologyOf,
  messagePage as messagePageOf,
  type MessagePageOptions,
  type WindowOptions,
  pageBySeq,
  parseCursor,
  seqOf,
  textPage,
  viewBytes,
} from './context-pages.js';
import { closeWorkDb, workDb } from './db.js';
import { mapLetterReader, storeLetterReader, writeLetters, type LetterQuery } from './letter-store.js';
import { unreadForHuman } from './letters.js';
import { addMessage, addSession } from './map.js';
import { addRoom } from './rooms.js';
import { createWork, updateMap } from './store.js';
import type { SessionNeed } from './stuck.js';
import { HUMAN, type MapCompactMail, type Message, type WindowWorkMap, type WorkMap } from './types.js';

// Хранимая карта писем не содержит (спека хранилища 6.2): страницы и снимок берут читателя писем. Чистые тесты читают письма
// самой карты с письмами; сборка из базы проверяется в `letter-store.test.ts` и хосте.
const messagePage = <V extends { text: string }>(map: WorkMap, options: MessagePageOptions<V>, letters: LetterReader = mapLetterReader(map as WindowWorkMap)) =>
  messagePageOf(map, options, letters);
const compactWorkMap = (map: WorkMap, options: WindowOptions, letters: LetterReader = mapLetterReader(map as WindowWorkMap)) =>
  compactWorkMapOf(map, options, letters);
const mapTopology = (map: WorkMap, callerId: string | null, letters: LetterReader = mapLetterReader(map as WindowWorkMap)) =>
  mapTopologyOf(map, callerId, letters);

const emptyMap = (): WindowWorkMap => ({
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
  addSession(map, { provider: 'codex', label: 'код', task: 'Написать', parent: null }).parent = 's-01';
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

  it('страницы не писем (история, артефакты, резюме, архив) держат прежний потолок 500: 100 им не навязан', () => {
    const items = Array.from({ length: 700 }, (_, index) => index + 1);
    const list = listPage(items, { view: (item) => item });
    expect(list.items).toHaveLength(500);
    expect(list.page).toMatchObject({ total: 700, complete: false, next: 'before:201' });
    const small = listPage(items.slice(0, 150), { view: (item) => item });
    expect(small.items).toHaveLength(150);
    expect(small.page).toMatchObject({ complete: true, next: null });
    const seq = pageBySeq(items.slice(0, 150), { seq: (item) => item, view: (item) => item, maxItems: 1000 });
    expect(seq.items).toHaveLength(150);
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

  it('страница не отдаёт больше 100 писем, как бы ни просили: ни предел байтов, ни maxItems его не раздвигают', () => {
    expect(LETTER_PAGE_MAX_ITEMS).toBe(100);
    expect(PAGE_MAX_ITEMS).toBe(500);
    const map = baseMap();
    fill(map, 250, 20);
    const seen: string[] = [];
    let cursor = null as ReturnType<typeof parseCursor>;
    for (let guard = 0; guard < 10; guard += 1) {
      const { messages, page } = messagePage(map, { roomId: 'r-01', maxBytes: PAGE_MAX_BYTES, maxItems: 500, cursor, view: (message) => message });
      expect(messages.length).toBeLessThanOrEqual(100);
      expect(page.total).toBe(250);
      seen.unshift(...ids(messages));
      if (page.complete) break;
      cursor = parseCursor(page.next);
    }
    expect(seen).toHaveLength(250);
    expect(new Set(seen).size).toBe(250);
    // Вперёд — тоже не больше 100.
    const forward = messagePage(map, { roomId: 'r-01', cursor: parseCursor('after:0'), view: (message) => message });
    expect(forward.messages).toHaveLength(100);
    expect(forward.page).toMatchObject({ complete: false, next: 'after:100' });
  });

  it('письма страницы берутся у читателя: карта без писем и читатель над массивом дают те же страницы, итоги и курсоры', () => {
    const map = baseMap();
    addRoom(map, { title: 'Другая', creator: HUMAN, members: ['s-02'], lead: 's-02' });
    fill(map, 30, 200);
    fill(map, 3, 50, { roomId: 'r-02' });
    addMessage(map, { from: 's-01', to: [], roomId: 'r-01', text: 'решили', kind: 'decision' });
    addMessage(map, { from: 's-01', to: ['s-02'], text: 'прямое' });
    const shell: WorkMap = { ...map, messages: [] };
    const reader = arrayReader(map.messages);
    for (const options of [
      { roomId: 'r-01' },
      { roomId: 'r-01', maxBytes: 2048 },
      { roomId: 'r-01', kind: 'decision' as const },
      { roomId: 'r-02' },
      { roomId: null },
      { roomId: 'r-01', cursor: parseCursor('before:20'), maxBytes: 2048 },
      { roomId: 'r-01', cursor: parseCursor('after:25') },
    ]) {
      const expected = messagePage(map, { ...options, view: (message) => message });
      const viaReader = messagePage(shell, { ...options, view: (message) => message }, reader);
      expect(viaReader, JSON.stringify(options)).toEqual(expected);
      expect(messagePage(shell, { ...options, view: (message) => message }, mapLetterReader(map)), JSON.stringify(options)).toEqual(expected);
    }
  });

  it('отбор filter считается и в итоге страницы, и в курсоре: письма, которые он отбросил, не попадают ни туда, ни сюда', () => {
    const map = baseMap();
    fill(map, 12, 40);
    fill(map, 12, 40, { from: 's-01' });
    const odd = (message: Message): boolean => seqOf(message.id, 'm-') % 2 === 1;
    const expected = messagePage(map, { roomId: 'r-01', filter: odd, maxItems: 5, view: (message) => message });
    const shell: WorkMap = { ...map, messages: [] };
    const viaReader = messagePage(shell, { roomId: 'r-01', filter: odd, maxItems: 5, view: (message) => message }, arrayReader(map.messages));
    expect(ids(viaReader.messages)).toEqual(['m-15', 'm-17', 'm-19', 'm-21', 'm-23']);
    expect(viaReader).toEqual(expected);
    expect(viaReader.page).toMatchObject({ total: 12, complete: false, next: 'before:15' });
  });

  it('итог отобранной страницы — один запрос читателю, а не обход канала пачками', () => {
    const map = baseMap();
    fill(map, 250, 20);
    const inner = arrayReader(map.messages);
    let queries = 0;
    const reader: LetterReader = {
      ...inner,
      page: (q) => {
        queries += 1;
        return inner.page(q);
      },
    };
    const odd = (message: Message): boolean => seqOf(message.id, 'm-') % 2 === 1;
    const { messages, page } = messagePage({ ...map, messages: [] }, { roomId: 'r-01', filter: odd, maxItems: 5, view: (message) => message }, reader);
    expect(ids(messages)).toEqual(['m-241', 'm-243', 'm-245', 'm-247', 'm-249']);
    expect(page.total).toBe(125);
    // Одна пачка набирает страницу, один запрос — итог.
    expect(queries).toBe(2);
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
  it('исключает private Codex proof из window и agent projections без изменения карты', () => {
    const map = baseMap();
    const proof = { launchRevision: '12345678-1234-1234-1234-123456789abc', pid: 42,
      startedAtProcess: 'private-process-stamp', threadId: '019ce3d5-584a-7be2-922e-b8185a8d7c19' };
    Object.assign(map.sessions[1]!, { codexThreadBinding: proof, providerSessionId: proof.threadId });
    const before = JSON.stringify(map);
    for (const projection of [compactWorkMap(map, { messageBytes: 1024 }), mapTopology(map, 's-01')]) {
      expect(JSON.stringify(projection)).not.toContain('codexThreadBinding');
      expect(JSON.stringify(projection)).not.toContain(proof.launchRevision);
      expect(JSON.stringify(projection)).not.toContain(proof.startedAtProcess);
    }
    expect(compactWorkMap(map, { messageBytes: 1024 }).sessions[1]?.providerSessionId).toBe(proof.threadId);
    expect(JSON.stringify(map)).toBe(before);
  });

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

  it('рои: хвост не больше WINDOW_LIST_MAX с числом опущенных, длинные тексты сокращены; без роёв ключа omitted нет', () => {
    const map = baseMap();
    const at = '2026-10-28T10:00:00.000Z';
    map.swarms = Array.from({ length: 130 }, (_, i) => ({
      id: `sw-${String(i + 1).padStart(3, '0')}`, tag: 'Research', creator: { kind: 'human' as const }, objective: 'Audit', queen: 's-01',
      members: [{ sessionId: 's-01', role: 'queen' as const, n: 1, addedAt: at, handedAt: null }],
      status: 'done' as const, createdAt: at, endedAt: at, result: { summary: 'итог', at, deliveredAt: null }, failure: null, seenAt: null, expiredAt: null,
    }));
    map.swarms[129]!.objective = 'ж'.repeat(100_000);
    map.swarms[129]!.result!.summary = 'ж'.repeat(100_000);

    const compact = compactWorkMap(map, { messageBytes: 1024 });
    expect(compact.swarms).toHaveLength(100);
    expect(compact.swarms?.[0]?.id).toBe('sw-031');
    expect(compact.swarms?.[99]?.id).toBe('sw-130');
    expect(compact.compact?.omitted['swarms']).toBe(30);
    expect(compact.swarms?.[99]?.objective).toContain('cut: ');
    expect(compact.swarms?.[99]?.result?.summary).toContain('cut: ');
    const cuts = compact.compact?.cut.map((cut) => cut.path) ?? [];
    expect(cuts).toContain('swarms[99].objective');
    expect(cuts).toContain('swarms[99].result.summary');

    const few = baseMap();
    few.swarms = map.swarms.slice(0, 3);
    const small = compactWorkMap(few, { messageBytes: 1024 });
    expect(small.swarms).toHaveLength(3);
    expect(small.compact?.omitted['swarms']).toBeUndefined();
    expect(compactWorkMap(baseMap(), { messageBytes: 1024 }).swarms).toBeUndefined();
  });

  it('агентская топология (get_map) роёв не показывает', () => {
    const map = baseMap();
    const at = '2026-10-28T10:00:00.000Z';
    map.swarms = [{
      id: 'sw-01', tag: 'Research', creator: { kind: 'human' }, objective: 'Audit', queen: 's-01',
      members: [{ sessionId: 's-01', role: 'queen', n: 1, addedAt: at, handedAt: null }],
      status: 'running', createdAt: at, endedAt: null, result: null, failure: null, seenAt: null, expiredAt: null,
    }];
    const text = JSON.stringify(mapTopology(map, 's-01'));
    expect(text).not.toContain('sw-01');
    expect(text).not.toContain('swarms');
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


/**
 * Работа для сверки снимка окна с прежним расчётом: активная и архивная комнаты, прямая почта, цитаты (своей и чужой
 * комнаты), длинное письмо и дыры в непрочитанном человеком. Номера писем зафиксированы в комментариях.
 */
function windowFixture(): WorkMap {
  const map = baseMap();
  addRoom(map, { title: 'Архивная', creator: HUMAN, members: ['s-02'], lead: 's-02' }); // r-02
  fill(map, 8, 30); // m-01…m-08 в r-01
  addMessage(map, { from: 's-01', to: [HUMAN], text: 'прямое человеку' }); // m-09
  fill(map, 6, 30, { roomId: 'r-02' }); // m-10…m-15
  map.rooms[1]!.archivedAt = '2026-10-08T12:00:00.000Z';
  addMessage(map, { from: 's-01', to: [], roomId: 'r-01', text: 'ответ на старое', replyTo: 'm-02' }); // m-16
  addMessage(map, { from: 's-02', to: [], roomId: 'r-01', text: 'ё'.repeat(40_000) }); // m-17: длиннее предела текста окна
  addMessage(map, { from: HUMAN, to: [], roomId: 'r-01', text: 'человек пишет в комнату' }); // m-18
  addMessage(map, { from: HUMAN, to: ['s-01'], text: 'человек пишет сессии' }); // m-19
  addMessage(map, { from: 's-02', to: [], roomId: 'r-01', text: 'свежее 20' }); // m-20
  addMessage(map, { from: 's-02', to: [], roomId: 'r-01', text: 'свежее 21' }); // m-21
  addMessage(map, { from: 's-02', to: [], roomId: 'r-01', text: 'я'.repeat(40_000) }); // m-22: тоже длиннее предела
  addMessage(map, { from: 's-01', to: [], roomId: 'r-01', text: 'цитирует начало', replyTo: 'm-02' }); // m-23
  addMessage(map, { from: 's-02', to: [], roomId: 'r-01', text: 'цитирует чужую комнату', replyTo: 'm-14' }); // m-24
  // Человек прочёл всё, кроме m-02, m-05 и писем с m-09 по m-15 и с m-20.
  const unread = new Set(['m-02', 'm-05', 'm-09', 'm-10', 'm-11', 'm-12', 'm-13', 'm-14', 'm-15', 'm-20', 'm-21', 'm-22', 'm-23', 'm-24']);
  for (const message of map.messages) if (!unread.has(message.id)) message.readBy[HUMAN] = '2026-10-05T00:00:00.000Z';
  return map;
}

/**
 * Читатель над массивом писем — отдельная от `mapLetterReader` реализация: проверяет, что страницы и снимок берут письма
 * только через интерфейс, а не из `map.messages`. Непрочитанное считает лишь для человека (правило `unreadForHuman`).
 */
function arrayReader(messages: readonly Message[]): LetterReader {
  const seq = (message: Message): number => seqOf(message.id, 'm-');
  const matcher = (q: Omit<LetterQuery, 'limit'>) => (message: Message): boolean =>
    (q.roomId === undefined || message.roomId === q.roomId) &&
    (q.kind === undefined || message.kind === q.kind) &&
    (q.from === undefined || message.from === q.from) &&
    (q.ids === undefined || q.ids.includes(message.id)) &&
    (q.beforeSeq === undefined || seq(message) < q.beforeSeq) &&
    (q.afterSeq === undefined || seq(message) > q.afterSeq);
  const sorted = [...messages].sort((a, b) => seq(a) - seq(b));
  const page = (q: LetterQuery): Message[] => {
    const found = sorted.filter(matcher(q));
    return (q.newestFirst === true ? found.reverse() : found).slice(0, q.limit);
  };
  const countBy = (list: readonly Message[]): Record<string, number> => {
    const byRoom: Record<string, number> = {};
    for (const message of list) byRoom[message.roomId ?? ''] = (byRoom[message.roomId ?? ''] ?? 0) + 1;
    return byRoom;
  };
  return {
    page,
    count: (q) => sorted.filter(matcher(q)).length,
    byIds: (ids) => sorted.filter((message) => ids.includes(message.id)),
    tail: (roomId, n) => sorted.filter((message) => message.roomId === roomId).slice(-n),
    humanUnread: (limit) => sorted.filter(unreadForHuman).slice(-limit),
    unreadCount: (reader) => {
      if (reader !== HUMAN) throw new Error('the test reader counts unread for the human only');
      const unread = sorted.filter(unreadForHuman);
      return { total: unread.length, byRoom: countBy(unread) };
    },
    channelStats: () => {
      const stats: Record<string, { total: number; latestId: string | null }> = {};
      for (const message of sorted) {
        const entry = (stats[message.roomId ?? ''] ??= { total: 0, latestId: null });
        entry.total += 1;
        entry.latestId = message.id;
      }
      return stats;
    },
  };
}

/** Чего ждёт снимок на `windowFixture`: расчёт прежней функции, снятый до перевода на читатель. */
const WINDOW_GOLDEN = [
  {
    messageBytes: 2000,
    ids: ['m-02', 'm-09', 'm-13', 'm-14', 'm-15', 'm-19', 'm-20', 'm-21', 'm-23', 'm-24'],
    textBytes: [] as [string, number][],
    compact: {
      version: 1,
      messages: {
        total: 24,
        included: 10,
        latestId: 'm-24',
        rooms: {
          'r-01': { total: 16, included: 5, tailFrom: 23 },
          direct: { total: 2, included: 2, tailFrom: 9 },
          'r-02': { total: 6, included: 3, tailFrom: 13 },
        },
      },
      unread: { letters: 1, rooms: { 'r-01': 7, 'r-02': 6 } },
      cut: [{ path: 'messages.m-22.text', bytes: 80000 }],
      omitted: {},
    },
  },
  {
    messageBytes: 1024 * 1024,
    ids: ['m-02', 'm-09', 'm-13', 'm-14', 'm-15', 'm-19', 'm-20', 'm-21', 'm-22', 'm-23', 'm-24'],
    textBytes: [['m-22', 80000]] as [string, number][],
    compact: {
      version: 1,
      messages: {
        total: 24,
        included: 11,
        latestId: 'm-24',
        rooms: {
          'r-01': { total: 16, included: 6, tailFrom: 20 },
          direct: { total: 2, included: 2, tailFrom: 9 },
          'r-02': { total: 6, included: 3, tailFrom: 13 },
        },
      },
      unread: { letters: 1, rooms: { 'r-01': 7, 'r-02': 6 } },
      cut: [{ path: 'messages.m-22.text', bytes: 80000 }],
      omitted: {},
    },
  },
];

describe('снимок окна: письма берутся у читателя', () => {
  const summary = (compact: WorkMap) => ({
    ids: ids(compact.messages),
    textBytes: compact.messages.filter((message) => message.textBytes !== undefined).map((message) => [message.id, message.textBytes]),
    compact: compact.compact,
  });

  for (const golden of WINDOW_GOLDEN) {
    it(`бюджет ${golden.messageBytes} Б: карта без писем и читатель над массивом дают расчёт прежней функции (архив, цитаты, длинные тексты)`, () => {
      const map = windowFixture();
      const options = { messageBytes: golden.messageBytes, recentPerRoom: 3, unreadMax: 5 };
      const expected = { ids: golden.ids, textBytes: golden.textBytes, compact: golden.compact };
      // Без читателя письма идут из `map.messages`.
      expect(summary(compactWorkMap(map, options))).toEqual(expected);
      // С читателем карта писем не нужна: пустая оболочка даёт тот же снимок.
      const shell: WorkMap = { ...map, messages: [] };
      const viaReader = compactWorkMap(shell, options, arrayReader(map.messages));
      expect(summary(viaReader)).toEqual(expected);
      // Читатель над картой (`mapLetterReader`) — тот же расчёт.
      expect(summary(compactWorkMap(shell, options, mapLetterReader(map)))).toEqual(expected);
      // Письма снимка — те же объекты по содержимому, что и в карте (с поправкой на сокращённый текст).
      for (const message of viaReader.messages) {
        const original = map.messages.find((candidate) => candidate.id === message.id) as Message;
        expect({ ...message, text: undefined, textBytes: undefined }).toEqual({ ...original, text: undefined, textBytes: undefined });
      }
    });
  }

  it('хвост без дыр идёт глубже хвоста комнаты, пока подряд лежат непрочитанные: больше одного запроса читателя', () => {
    const map = baseMap();
    fill(map, 120, 20);
    const shell: WorkMap = { ...map, messages: [] };
    const compact = compactWorkMap(shell, { messageBytes: 1024 * 1024, recentPerRoom: 5, unreadMax: 200 }, arrayReader(map.messages));
    expect(compact.compact?.messages.rooms['r-01']).toEqual({ total: 120, included: 120, tailFrom: 1 });
    expect(compact.messages).toHaveLength(120);
  });

  it('счётчики и итоги приходят от читателя, а не пересчитываются по карте', () => {
    const map = windowFixture();
    const shell: WorkMap = { ...map, messages: [] };
    const reader = arrayReader(map.messages);
    const topology = mapTopology(shell, HUMAN, {
      ...reader,
      unreadCount: () => ({ total: 7, byRoom: { 'r-01': 4, '': 3 } }),
    });
    expect(topology.messages.unreadForYou).toEqual({ total: 7, rooms: { 'r-01': 4 }, direct: 3 });
    expect(topology.messages).toMatchObject({ total: 24, latestId: 'm-24', direct: { total: 2, latestId: 'm-19' } });
    expect(topology.rooms[0]?.messages).toEqual({ total: 16, latestId: 'm-24', unreadForYou: 4 });
    expect(topology.rooms[1]?.messages).toEqual({ total: 6, latestId: 'm-15', unreadForYou: 0 });
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

  it('stuck: потребность из карты как есть, а нет поля в карте — null (спека застрявших 5.1, 5.3)', () => {
    const map = baseMap();
    const need: SessionNeed = {
      kind: 'limit',
      since: '2026-10-21T14:02:00.000Z',
      detail: null,
      resetsAt: '2026-10-21T16:27:00.000Z',
      window: 'session',
      account: null,
    };
    map.sessions[1]!.stuck = need;
    map.sessions[0]!.stuck = null;

    const topology = mapTopology(map, 's-01');

    expect(topology.sessions[0]?.stuck).toBeNull();
    expect(topology.sessions[1]?.stuck).toEqual(need);
    // Старая карта без поля: ключ в ответе есть и равен null, а не пропал.
    delete map.sessions[1]!.stuck;
    expect(mapTopology(map, 's-01').sessions[1]).toHaveProperty('stuck', null);
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
    expect(topology.rooms[0]).toHaveProperty('ownerId', map.rooms[0]!.ownerId);
    expect(topology.rooms[0]?.proposal?.cut).toEqual({ text: 10_000 });
    expect(topology.plans.map((row) => row.id)).toEqual(['pl-2']);
    expect(topology.plans[0]?.items[0]?.log).toHaveLength(3);
  });
});

describe('кандидаты в упоминания человека', () => {
  const letter = (n: number, text: string): Message => ({
    id: `m-${n}`,
    roomId: 'r-01',
    from: 's-02',
    to: [],
    at: '2026-10-27T10:00:00.000Z',
    kind: 'note',
    text,
    readBy: {},
  });
  const bytes = (letters: Message[]): number => Buffer.byteLength(JSON.stringify(letters), 'utf8');

  it('отбирает письма, которые проходят plainHumanMention, порядок письма сохраняется', () => {
    const unread = [letter(1, '@human, посмотрите'), letter(2, 'без упоминания'), letter(3, 'mail@humanity.org не человек'), letter(4, 'ещё раз @human')];

    expect(humanMentionCandidates(unread).map((message) => message.id)).toEqual(['m-1', 'm-4']);
  });

  it('не больше WINDOW_UNREAD_MAX: остаются последние', () => {
    const unread = Array.from({ length: WINDOW_UNREAD_MAX + 50 }, (_, at) => letter(at + 1, '@human'));

    const candidates = humanMentionCandidates(unread);

    expect(candidates).toHaveLength(WINDOW_UNREAD_MAX);
    expect(candidates[0]?.id).toBe('m-51');
    expect(candidates.at(-1)?.id).toBe(`m-${WINDOW_UNREAD_MAX + 50}`);
  });

  it('потолок в байтах: остаются самые новые подряд, а старые не едут', () => {
    // Семьдесят писем по 4 КиБ вместе выше потолка: событие и снимок несут один и тот же урезанный набор.
    const unread = Array.from({ length: 70 }, (_, at) => letter(at + 1, `@human ${'x'.repeat(4096)}`));

    const candidates = humanMentionCandidates(unread);

    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.length).toBeLessThan(unread.length);
    // Скобки массива не в счёте: потолок мерит письма и запятые между ними.
    expect(bytes(candidates) - 2).toBeLessThanOrEqual(WINDOW_MENTION_MAX_BYTES);
    expect(candidates.at(-1)?.id).toBe('m-70');
    const first = Number((candidates[0] as Message).id.slice(2));
    expect(candidates.map((message) => message.id)).toEqual(Array.from({ length: 70 - first + 1 }, (_, at) => `m-${first + at}`));
  });

  it('длинный текст режется как у письма окна: до WINDOW_TEXT_MAX, с textBytes', () => {
    const text = `@human ${'я'.repeat(100 * 1024)}`;

    const [candidate] = humanMentionCandidates([letter(1, text)]);

    expect(candidate?.textBytes).toBe(Buffer.byteLength(text, 'utf8'));
    expect(viewBytes(candidate)).toBeLessThanOrEqual(WINDOW_TEXT_MAX);
  });

  it('keepNewestWithin: письмо, которое не влезает одно, обрывает набор целиком; нулевой потолок даёт пустой набор', () => {
    const unread = [letter(1, 'a'), letter(2, 'b'.repeat(3000)), letter(3, 'c')];

    // Хвост без дыр: влезло бы письмо 1, но между ним и письмом 3 лежит письмо 2, которое не влезает.
    expect(keepNewestWithin(unread, 500).map((message) => message.id)).toEqual(['m-3']);
    expect(keepNewestWithin(unread, 0)).toEqual([]);
    expect(keepNewestWithin(unread, 1_000_000)).toEqual(unread);
  });
});

describe('снимок без писем (rooms.mail 6.8)', () => {
  const shellOf = (map: WindowWorkMap): WorkMap => ({ ...map, messages: [] }) as WorkMap;
  const fixture = (): WindowWorkMap => windowFixture() as WindowWorkMap;
  const base = (): WindowWorkMap => baseMap() as WindowWorkMap;
  const atOf = (map: WindowWorkMap, id: string): string => (map.messages.find((message) => message.id === id) as Message).at;
  const mailOf = (map: WindowWorkMap): MapCompactMail => {
    if (map.compact?.version !== 2) throw new Error('the snapshot is not letterless');
    return map.compact;
  };

  it('не несёт писем и даёт total/top/lastAt/unread по комнатам и прямым; unread — итог и разбивка события', () => {
    const map = fixture();
    const snapshot = mailWorkMap(shellOf(map), arrayReader(map.messages), {});

    expect(snapshot.messages).toEqual([]);
    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.sessions.map((session) => session.id)).toEqual(['s-01', 's-02']);
    expect(snapshot.rooms.map((room) => room.id)).toEqual(['r-01', 'r-02']);
    // `unread.letters` — итог человека по работе (как `unreadCount(HUMAN).total`), прямые письма — ключ '' в `rooms`.
    expect(snapshot.compact).toEqual({
      version: 2,
      rooms: {
        '': { total: 2, top: 19, lastAt: atOf(map, 'm-19'), unread: 1, decision: null },
        'r-01': { total: 16, top: 24, lastAt: atOf(map, 'm-24'), unread: 7, decision: null },
        'r-02': { total: 6, top: 15, lastAt: atOf(map, 'm-15'), unread: 6, decision: null },
      },
      unread: { letters: 14, rooms: { '': 1, 'r-01': 7, 'r-02': 6 } },
      mentionCandidates: [],
      cut: [],
      omitted: {},
    });
  });

  it('комната и прямые без писем остаются в снимке нулями, а не пропадают', () => {
    const map = base();
    const snapshot = mailWorkMap(shellOf(map), arrayReader([]), {});

    expect(snapshot.compact).toMatchObject({
      version: 2,
      rooms: {
        '': { total: 0, top: 0, lastAt: null, unread: 0, decision: null },
        'r-01': { total: 0, top: 0, lastAt: null, unread: 0, decision: null },
      },
      unread: { letters: 0, rooms: {} },
    });
  });

  it('читатель над картой и читатель над массивом дают один снимок', () => {
    const map = fixture();

    expect(mailWorkMap(shellOf(map), mapLetterReader(map), {})).toEqual(mailWorkMap(shellOf(map), arrayReader(map.messages), {}));
  });

  it('сессии, комнаты и планы ужимаются как в compactWorkMap: длинное сокращено, пути названы, история обрезана хвостом', () => {
    const map = fixture();
    (map.sessions[0] as WorkMap['sessions'][number]).task = 'я'.repeat(2000);
    const session = map.sessions[1] as WorkMap['sessions'][number];
    for (let i = 0; i < 130; i += 1) session.history.push({ event: 'active', at: '2026-10-05T00:00:00.000Z' });
    map.decisionExports = [{ file: 'f', workId: 'w', roomId: 'r', proposalId: 'p', rev: 0, messageId: 'm', acceptedAt: 'x', kind: 'decision', snapshot: null, snapshotSha256: null, content: 'ж'.repeat(100_000), status: 'pending' }];
    map.planExports = [{ file: 'p.md', planId: 'pl-1', rev: 1, event: 'accepted', content: 'ж'.repeat(100_000), status: 'pending' }];

    const letterless = mailWorkMap(shellOf(map), arrayReader(map.messages), { textMax: 500 });
    const compact = compactWorkMap(shellOf(map), { messageBytes: 0, textMax: 500 }, arrayReader(map.messages));

    for (const field of ['work', 'sessions', 'rooms', 'plans', 'planExports', 'planEffects', 'decisionExports'] as const) {
      expect(letterless[field], field).toEqual(compact[field]);
    }
    expect(letterless.sessions[1]?.history).toHaveLength(100);
    expect(letterless.planExports).toEqual([{ file: 'p.md', planId: 'pl-1', rev: 1, event: 'accepted', content: '', status: 'pending' }]);
    expect(letterless.compact).toMatchObject({ version: 2, omitted: { 'sessions.s-02.history': 31, decisionExports: 1 } });
    expect(letterless.compact?.cut.map((cut) => cut.path)).toContain('sessions.s-01.task');
  });

  it('итог последнего решения комнаты: принято и возвращено; слова человека между ответами и до них его не прячут', () => {
    const map = base();
    addRoom(map, { title: 'Вторая', creator: HUMAN, members: ['s-01', 's-02'], lead: 's-01' }); // r-02
    addRoom(map, { title: 'Третья', creator: HUMAN, members: ['s-01', 's-02'], lead: 's-01' }); // r-03
    addRoom(map, { title: 'Четвёртая', creator: HUMAN, members: ['s-01', 's-02'], lead: 's-01' }); // r-04
    addMessage(map, { from: HUMAN, to: ['s-01'], roomId: 'r-01', text: 'Returned for rework: add tests' });
    addMessage(map, { from: HUMAN, to: ['s-01'], roomId: 'r-01', text: 'Decision accepted.' });
    addMessage(map, { from: HUMAN, to: ['s-01'], roomId: 'r-02', text: 'Decision accepted.' });
    addMessage(map, { from: HUMAN, to: ['s-01'], roomId: 'r-02', text: 'Returned for rework.' });
    // Свои слова человека после ответа в счёт не идут, как в `roomDecisionReturned` окна.
    addMessage(map, { from: HUMAN, to: ['s-01'], roomId: 'r-02', text: 'и ещё проверь краевой случай' });
    addMessage(map, { from: 's-01', to: [], roomId: 'r-03', text: 'Decision accepted.' }); // не от человека
    addMessage(map, { from: HUMAN, to: ['s-01'], roomId: 'r-03', text: 'просто слова' });

    const snapshot = mailWorkMap(shellOf(map), arrayReader(map.messages), {});
    const decisions = Object.fromEntries(Object.entries(mailOf(snapshot).rooms).map(([id, room]) => [id, room.decision]));

    expect(decisions).toEqual({ '': null, 'r-01': 'accepted', 'r-02': 'returned', 'r-03': null, 'r-04': null });
  });

  it('кандидаты в упоминания — непрочитанный хвост человека через общий помощник, текст сокращён по textMax', () => {
    const map = base();
    addMessage(map, { from: 's-02', to: [], roomId: 'r-01', text: '@human посмотри' }); // m-01
    addMessage(map, { from: 's-02', to: [], roomId: 'r-01', text: 'без упоминания' }); // m-02
    addMessage(map, { from: 's-02', to: [], roomId: 'r-01', text: `@human ${'я'.repeat(4000)}` }); // m-03
    addMessage(map, { from: 's-02', to: [], roomId: 'r-01', text: '@human уже прочитано' }); // m-04
    (map.messages[3] as Message).readBy[HUMAN] = '2026-10-05T00:00:00.000Z';

    const snapshot = mailWorkMap(shellOf(map), arrayReader(map.messages), { textMax: 1000 });
    const candidates = mailOf(snapshot).mentionCandidates;

    expect(candidates.map((message) => message.id)).toEqual(['m-01', 'm-03']);
    expect(candidates).toEqual(humanMentionCandidates(arrayReader(map.messages).humanUnread(WINDOW_UNREAD_MAX), 1000));
    expect(candidates[1]?.textBytes).toBe(Buffer.byteLength(`@human ${'я'.repeat(4000)}`, 'utf8'));
  });

  it('набор кандидатов не больше WINDOW_UNREAD_MAX последних непрочитанных: старые за хвостом не едут', () => {
    const map = base();
    for (let at = 0; at < WINDOW_UNREAD_MAX + 20; at += 1) addMessage(map, { from: 's-02', to: [], roomId: 'r-01', text: '@human' });

    const snapshot = mailWorkMap(shellOf(map), arrayReader(map.messages), {});
    const candidates = mailOf(snapshot).mentionCandidates;

    expect(candidates).toHaveLength(WINDOW_UNREAD_MAX);
    expect(candidates.at(-1)?.id).toBe(`m-${WINDOW_UNREAD_MAX + 20}`);
  });

  describe('над базой', () => {
    let home = '';
    let project = '';

    beforeEach(async () => {
      home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
      project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
      process.env.PARLEY_HOME = home;
    });

    afterEach(async () => {
      closeWorkDb();
      delete process.env.PARLEY_HOME;
      await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
    });

    it('размер не меняется от 10 000 писем: до и после разница меньше 200 байт', async () => {
      await createWork(project, { title: 'много писем' });
      const map = await updateMap(project, 'w-0001', (stored) => {
        addSession(stored, { provider: 'claude', label: 'план', task: 'Спланировать' });
        addRoom(stored, { title: 'Обсуждение', creator: HUMAN, members: ['s-01'], lead: 's-01' });
      });
      const letterless = (): string => JSON.stringify(mailWorkMap(map, storeLetterReader(project, 'w-0001'), {}));

      const before = letterless().length;
      writeLetters(project, 'w-0001', (letters) => {
        for (let at = 0; at < 10_000; at += 1) {
          const direct = at % 2 === 0;
          letters.add({
            roomId: direct ? null : 'r-01',
            from: 's-01',
            to: direct ? [HUMAN] : [],
            kind: 'note',
            text: `письмо ${at} ${'я'.repeat(200)}`,
          });
        }
      });
      const after = letterless().length;

      expect(Math.abs(after - before)).toBeLessThan(200);
      expect(after).toBeLessThan(4096);
      expect(JSON.parse(letterless()).compact).toMatchObject({
        version: 2,
        rooms: { '': { total: 5000, top: 9999, unread: 5000 }, 'r-01': { total: 5000, top: 10_000, unread: 5000 } },
        unread: { letters: 10_000 },
      });
    });

    it('письма человека комнаты берутся по индексу messages_sender: без обхода комнаты и без сортировки (спека rooms.mail 6.8)', async () => {
      await createWork(project, { title: 'решение' });
      const map = await updateMap(project, 'w-0001', (stored) => {
        addSession(stored, { provider: 'claude', label: 'план', task: 'Спланировать' });
        addRoom(stored, { title: 'Обсуждение', creator: HUMAN, members: ['s-01'], lead: 's-01' });
      });
      writeLetters(project, 'w-0001', (letters) => {
        letters.add({ roomId: 'r-01', from: HUMAN, to: ['s-01'], kind: 'note', text: 'Decision accepted.' });
        for (let at = 0; at < 200; at += 1) letters.add({ roomId: 'r-01', from: 's-01', to: [], kind: 'note', text: `письмо ${at}` });
      });
      const db = workDb();
      const prepared = vi.spyOn(db, 'prepare');

      const snapshot = mailWorkMap(map, storeLetterReader(project, 'w-0001'), {});

      const queries = prepared.mock.calls.map(([text]) => text).filter((text) => /m\.sender = \?/.test(text));
      prepared.mockRestore();
      expect(queries.length).toBeGreaterThan(0);
      expect((snapshot.compact as MapCompactMail).rooms['r-01']?.decision).toBe('accepted');
      for (const text of queries) {
        const binds = Array.from({ length: (text.match(/\?/g) ?? []).length }, () => 1);
        const plan = (db.prepare(`EXPLAIN QUERY PLAN ${text}`).all(...binds) as Array<{ detail: string }>).map((row) => row.detail);
        expect(plan.join('\n')).toContain('USING INDEX messages_sender');
        expect(plan.join('\n')).not.toMatch(/SCAN|TEMP B-TREE/);
      }
    });
  });
});
