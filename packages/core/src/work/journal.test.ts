import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Сколько байт журналов прочитано с диска: тест наблюдает чтение, а не время.
 * Считаются `handle.read` и `readFile` — других путей чтения у журнала быть не должно.
 */
const disk = { bytes: 0 };

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const data = await actual.readFile(...args);
      disk.bytes += typeof data === 'string' ? Buffer.byteLength(data) : data.length;
      return data;
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const read = handle.read.bind(handle) as (...a: unknown[]) => Promise<{ bytesRead: number }>;
      return Object.assign(handle, {
        read: async (...a: unknown[]) => {
          const result = await read(...a);
          disk.bytes += result.bytesRead;
          return result;
        },
      });
    },
  };
});

const { appendMessage, findMessage, readCursors, readMessages, readPage, writeCursor, journalFile } = await import('./journal.js');
const { unreadFromJournals, unreadFor } = await import('./letters.js');
const { workPaths } = await import('./store.js');
const { HUMAN } = await import('./types.js');
import type { Message, Room, WorkMap } from './types.js';

const WORK = 'w-0001';
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
let project = '';

beforeEach(async () => {
  project = await mkdtemp(path.join(tmpdir(), 'parley-journal-'));
  disk.bytes = 0;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(project, { recursive: true, force: true });
});

/** Строка журнала, записанная руками: формат закреплён здесь независимо от кода. */
const line = (seq: number, roomId: string | null, id: string, text = `письмо ${seq}`): string =>
  `${JSON.stringify({ seq, id, roomId, from: 's-01', to: [], text, kind: 'note', at: '2026-10-16T10:00:00.000Z' })}\n`;

const seed = async (roomId: string | null, lines: string[]): Promise<string> => {
  const file = journalFile(workPaths(project, WORK), roomId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, lines.join(''));
  return file;
};

const note = (text: string, extra: Partial<{ from: string; to: string[] }> = {}) => ({ from: 's-01', to: [] as string[], text, ...extra });

const linesOf = async (file: string): Promise<string[]> => (await readFile(file, 'utf8')).split('\n').filter((row) => row !== '');

describe('appendMessage', () => {
  it('создаёт журнал комнаты, пишет одну строку и возвращает письмо с id', async () => {
    const stored = await appendMessage(project, WORK, 'r-01', { ...note('привет'), kind: 'question', replyTo: 'm-r01-0' });
    expect(stored).toMatchObject({ id: 'm-r01-1', seq: 1, roomId: 'r-01', from: 's-01', to: [], text: 'привет', kind: 'question', replyTo: 'm-r01-0' });
    expect(typeof stored.at).toBe('string');
    const file = journalFile(workPaths(project, WORK), 'r-01');
    expect(file).toBe(path.join(workPaths(project, WORK).dir, 'rooms', 'r-01', 'messages.jsonl'));
    const rows = await linesOf(file);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0] ?? '')).toEqual(stored);
    expect(Object.keys(stored)).not.toContain('readBy');
  });

  it('прямые письма: id m-d-<seq>, журнал direct/messages.jsonl, roomId null', async () => {
    const first = await appendMessage(project, WORK, null, note('раз', { to: ['s-02'] }));
    const second = await appendMessage(project, WORK, null, note('два', { to: ['s-02'] }));
    expect([first.id, second.id]).toEqual(['m-d-1', 'm-d-2']);
    expect(first.roomId).toBeNull();
    expect(journalFile(workPaths(project, WORK), null)).toBe(path.join(workPaths(project, WORK).dir, 'direct', 'messages.jsonl'));
  });

  it('два процесса пишут в один журнал: строки с подряд идущими seq, без потерь', async () => {
    const code = `
      import { appendMessage } from ${JSON.stringify(path.join(repoRoot, 'packages/core/src/work/journal.ts'))};
      const [project, tag] = [process.env.J_PROJECT, process.env.J_TAG];
      for (let i = 0; i < 15; i += 1) await appendMessage(project, 'w-0001', 'r-01', { from: 's-01', to: [], text: tag + i });
    `;
    const run = (tag: string): Promise<void> =>
      new Promise((resolve, reject) => {
        execFile(
          process.execPath,
          ['--import', 'tsx', '--input-type=module', '-e', code],
          { cwd: repoRoot, env: { ...process.env, J_PROJECT: project, J_TAG: tag } },
          (error, _out, err) => (error ? reject(new Error(`${error.message}\n${err}`)) : resolve()),
        );
      });
    await Promise.all([run('a'), run('b')]);

    const rows = (await linesOf(journalFile(workPaths(project, WORK), 'r-01'))).map((row) => JSON.parse(row) as { seq: number; id: string; text: string });
    expect(rows.map((row) => row.seq)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(new Set(rows.map((row) => row.id)).size).toBe(30);
    expect(rows.filter((row) => row.text.startsWith('a'))).toHaveLength(15);
    expect(rows.filter((row) => row.text.startsWith('b'))).toHaveLength(15);
  }, 60_000);

  it('журнал с прежними id m-NN: нумерация продолжается по seq, без столкновений', async () => {
    await seed('r-01', Array.from({ length: 500 }, (_, i) => line(i + 1, 'r-01', `m-${String(i + 1).padStart(2, '0')}`)));
    const stored = await appendMessage(project, WORK, 'r-01', note('после миграции'));
    expect(stored.id).toBe('m-r01-501');
    expect(stored.seq).toBe(501);
  });

  it('оборванная последняя строка: следующее письмо идёт с новой строки, seq берётся с предыдущей целой', async () => {
    const file = await seed('r-01', [line(1, 'r-01', 'm-r01-1'), line(2, 'r-01', 'm-r01-2')]);
    await appendFile(file, '{"seq":3,"id":"m-r01-3","roomId":"r-0');
    const stored = await appendMessage(project, WORK, 'r-01', note('после обрыва'));
    expect(stored.seq).toBe(3);
    const rows = await linesOf(file);
    expect(rows).toHaveLength(4);
    expect(JSON.parse(rows[3] ?? '').seq).toBe(3);
  });

  it('хвост журнала из мусора: нумерация не начинается заново, письмо не пишется', async () => {
    const file = await seed('r-01', [line(1, 'r-01', 'm-r01-1'), ...Array.from({ length: 70 }, (_, i) => `мусор ${i}\n`)]);
    const before = await readFile(file, 'utf8');
    await expect(appendMessage(project, WORK, 'r-01', note('не должно записаться'))).rejects.toThrow(/refusing to restart numbering/);
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it('вся запись из мусора короче предела: тоже отказ, а не seq 1', async () => {
    await seed('r-01', ['мусор\n', 'ещё мусор\n']);
    await expect(appendMessage(project, WORK, 'r-01', note('нельзя'))).rejects.toThrow(/refusing to restart numbering/);
  });

  it('замок журнала отдельный: письмо не ждёт map.lock', async () => {
    const paths = workPaths(project, WORK);
    await mkdir(paths.dir, { recursive: true });
    await writeFile(paths.lock, '');
    const stored = await appendMessage(project, WORK, 'r-01', note('пока индекс занят'));
    expect(stored.seq).toBe(1);
    await expect(stat(path.join(path.dirname(journalFile(paths, 'r-01')), 'messages.lock'))).rejects.toThrow();
  });

  it('id комнаты и сессии не выходят из каталога работы', async () => {
    await expect(appendMessage(project, WORK, '../x', note('плохо'))).rejects.toThrow(/invalid/);
    await expect(readCursors(project, WORK, '../s-01')).rejects.toThrow(/invalid/);
  });

  it('на 10 000 писем одно письмо читает с диска столько же, сколько на 100', async () => {
    const perAppend = async (count: number): Promise<number> => {
      await seed('r-01', Array.from({ length: count }, (_, i) => line(i + 1, 'r-01', `m-r01-${i + 1}`, 'x'.repeat(200))));
      const worst: number[] = [];
      for (let i = 0; i < 20; i += 1) {
        disk.bytes = 0;
        const stored = await appendMessage(project, WORK, 'r-01', note('ещё'));
        expect(stored.seq).toBe(count + i + 1);
        worst.push(disk.bytes);
      }
      return Math.max(...worst);
    };
    const small = await perAppend(100);
    const big = await perAppend(10_000);
    expect(big).toBeLessThanOrEqual(16 * 1024);
    expect(big).toBeLessThanOrEqual(small + 1024);
  }, 60_000);
});

describe('readMessages', () => {
  it('страница из журнала в 2 МБ читает с диска не больше 64 КБ и отдаёт письма по порядку', async () => {
    const rows = Array.from({ length: 10_000 }, (_, i) => line(i + 1, 'r-01', `m-r01-${i + 1}`, 'я'.repeat(80)));
    const file = await seed('r-01', rows);
    expect((await stat(file)).size).toBeGreaterThan(2 * 1024 * 1024);

    disk.bytes = 0;
    const page = await readMessages(project, WORK, 'r-01', { limit: 50, maxBytes: 64 * 1024 });
    expect(disk.bytes).toBeLessThanOrEqual(64 * 1024);
    expect(page.map((message) => message.seq)).toEqual(Array.from({ length: 50 }, (_, i) => 9951 + i));

    disk.bytes = 0;
    const small = await readMessages(project, WORK, 'r-01', { limit: 1000, maxBytes: 10_000 });
    expect(disk.bytes).toBeLessThanOrEqual(10_000 + 16 * 1024);
    expect(small.length).toBeGreaterThan(0);
    expect(small.length).toBeLessThan(60);
    expect(small[small.length - 1]?.seq).toBe(10_000);
  });

  it('maxBytes — единственный предел: 64 КБ на журнале в 2 МБ при безлимитном limit', async () => {
    const file = await seed('r-01', Array.from({ length: 10_000 }, (_, i) => line(i + 1, 'r-01', `m-r01-${i + 1}`, 'я'.repeat(80))));
    expect((await stat(file)).size).toBeGreaterThan(2 * 1024 * 1024);
    disk.bytes = 0;
    const page = await readMessages(project, WORK, 'r-01', { limit: 1_000_000, maxBytes: 64 * 1024 });
    // limit не мог остановить чтение: строк в журнале в 10 раз больше, чем уместилось
    expect(page.length).toBeGreaterThan(50);
    expect(page.length).toBeLessThan(10_000);
    // страница занимает почти весь предел: его остановил именно maxBytes
    const used = page.reduce((sum, message) => sum + Buffer.byteLength(JSON.stringify(message)), 0);
    expect(used).toBeLessThanOrEqual(64 * 1024);
    expect(used).toBeGreaterThan(64 * 1024 - 300);
    expect(page[page.length - 1]?.seq).toBe(10_000);
    expect(disk.bytes).toBeLessThanOrEqual(64 * 1024 + 16 * 1024);
  });

  it('одно письмо крупнее maxBytes отдаётся целиком, и только оно', async () => {
    await seed('r-01', [line(1, 'r-01', 'm-r01-1'), line(2, 'r-01', 'm-r01-2', 'ю'.repeat(40_000))]);
    const page = await readMessages(project, WORK, 'r-01', { limit: 10, maxBytes: 1000 });
    expect(page.map((message) => message.seq)).toEqual([2]);
    expect(page[0]?.text.length).toBe(40_000);
    const forward = await readPage(project, WORK, 'r-01', { after: 'm-r01-1', limit: 10, maxBytes: 1000 });
    expect(forward.letters.map((message) => message.seq)).toEqual([2]);
    expect(forward.more).toBe(false);
  });

  it('несуществующий журнал — пустой список', async () => {
    expect(await readMessages(project, WORK, 'r-09', { limit: 10, maxBytes: 1000 })).toEqual([]);
  });

  it('оборванная последняя строка пропускается с предупреждением, остальное читается', async () => {
    const file = await seed('r-01', [line(1, 'r-01', 'm-r01-1'), line(2, 'r-01', 'm-r01-2'), line(3, 'r-01', 'm-r01-3')]);
    await appendFile(file, '{"seq":4,"id":"m-r01-4","roomId":"r-0');
    const warn = vi.fn();
    const page = await readMessages(project, WORK, 'r-01', { limit: 10, maxBytes: 100_000, warn });
    expect(page.map((message) => message.id)).toEqual(['m-r01-1', 'm-r01-2', 'm-r01-3']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('messages.jsonl');
  });

  it('битая строка посреди журнала тоже пропускается', async () => {
    await seed('r-01', [line(1, 'r-01', 'm-r01-1'), 'не json\n', line(3, 'r-01', 'm-r01-3')]);
    const warn = vi.fn();
    const page = await readMessages(project, WORK, 'r-01', { limit: 10, maxBytes: 100_000, warn });
    expect(page.map((message) => message.seq)).toEqual([1, 3]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  describe('after и before', () => {
    beforeEach(async () => {
      await seed('r-01', Array.from({ length: 10 }, (_, i) => line(i + 1, 'r-01', `m-${String(i + 1).padStart(2, '0')}`)));
    });
    const ids = async (opts: { after?: string; before?: string; limit?: number }) =>
      (await readMessages(project, WORK, 'r-01', { limit: opts.limit ?? 100, maxBytes: 100_000, ...opts })).map((message) => message.id);

    it('after — письма строго после id, по порядку журнала', async () => {
      expect(await ids({ after: 'm-07' })).toEqual(['m-08', 'm-09', 'm-10']);
      expect(await ids({ after: 'm-10' })).toEqual([]);
    });

    it('before — письма строго до id; страница — ближайшие к нему, но по порядку журнала', async () => {
      expect(await ids({ before: 'm-04' })).toEqual(['m-01', 'm-02', 'm-03']);
      expect(await ids({ before: 'm-08', limit: 2 })).toEqual(['m-06', 'm-07']);
    });

    it('after и before вместе — окно между ними', async () => {
      expect(await ids({ after: 'm-02', before: 'm-06' })).toEqual(['m-03', 'm-04', 'm-05']);
    });

    it('after при превышении limit отдаёт самые СТАРЫЕ письма после id и сигнал more', async () => {
      expect(await ids({ after: 'm-02', limit: 3 })).toEqual(['m-03', 'm-04', 'm-05']);
      const page = await readPage(project, WORK, 'r-01', { after: 'm-02', limit: 3, maxBytes: 100_000 });
      expect(page.more).toBe(true);
    });

    it('страница, которая поместилась, more не выставляет; пустая тоже', async () => {
      const opts = { maxBytes: 100_000 };
      expect((await readPage(project, WORK, 'r-01', { after: 'm-07', limit: 3, ...opts })).more).toBe(false);
      expect((await readPage(project, WORK, 'r-01', { after: 'm-07', limit: 100, ...opts })).more).toBe(false);
      expect(await readPage(project, WORK, 'r-01', { after: 'm-10', limit: 3, ...opts })).toEqual({ letters: [], more: false });
    });

    it('курсор за курсором: каждое письмо приходит ровно один раз и по порядку', async () => {
      const seen: string[] = [];
      let cursor = 'm-01';
      for (let guard = 0; guard < 20; guard += 1) {
        const page = await readPage(project, WORK, 'r-01', { after: cursor, limit: 4, maxBytes: 100_000 });
        seen.push(...page.letters.map((message) => message.id));
        const last = page.letters[page.letters.length - 1];
        if (last !== undefined) cursor = last.id;
        if (!page.more) break;
      }
      expect(seen).toEqual(['m-02', 'm-03', 'm-04', 'm-05', 'm-06', 'm-07', 'm-08', 'm-09', 'm-10']);
    });

    it('maxBytes тоже делит страницы с more, ничего не теряя', async () => {
      const rowBytes = Buffer.byteLength(line(1, 'r-01', 'm-01')) - 1;
      const seen: string[] = [];
      let cursor = 'm-01';
      let more = true;
      let pages = 0;
      while (more && pages < 20) {
        const page = await readPage(project, WORK, 'r-01', { after: cursor, limit: 100, maxBytes: rowBytes * 3 + 2 });
        expect(page.letters.length).toBeLessThanOrEqual(3);
        seen.push(...page.letters.map((message) => message.id));
        cursor = page.letters[page.letters.length - 1]?.id ?? cursor;
        more = page.more;
        pages += 1;
      }
      expect(pages).toBe(3);
      expect(seen).toEqual(['m-02', 'm-03', 'm-04', 'm-05', 'm-06', 'm-07', 'm-08', 'm-09', 'm-10']);
    });

    it('findMessage находит письмо по id и не находит чужое', async () => {
      expect((await findMessage(project, WORK, 'r-01', 'm-04'))?.seq).toBe(4);
      expect(await findMessage(project, WORK, 'r-01', 'm-99')).toBeUndefined();
      expect(await findMessage(project, WORK, 'r-09', 'm-04')).toBeUndefined();
    });

    it('неизвестный after — как будто id не задан: страница с конца; неизвестный before — пусто', async () => {
      expect(await ids({ after: 'm-zzz', limit: 3 })).toEqual(['m-08', 'm-09', 'm-10']);
      expect(await ids({ before: 'm-zzz' })).toEqual([]);
    });
  });
});

describe('курсор на письмо, которого больше нет (fromStart)', () => {
  it('по номеру в id отдаёт только письма с большим номером, журнал с начала не воспроизводится', async () => {
    // Письма 3 в журнале нет (убрано), курсор на него стоял.
    await seed('r-01', [line(1, 'r-01', 'm-r01-1'), line(2, 'r-01', 'm-r01-2'), line(4, 'r-01', 'm-r01-4'), line(5, 'r-01', 'm-r01-5')]);
    const warn = vi.fn();
    const page = await readPage(project, WORK, 'r-01', { after: 'm-r01-3', fromStart: true, warn });
    expect(page.letters.map((letter) => letter.id)).toEqual(['m-r01-4', 'm-r01-5']);
    expect(page.clampedTo).toBeUndefined();
  });

  it('без номера в id курсор прижимается к концу журнала с предупреждением, ничего не отдаётся', async () => {
    await seed('r-01', [line(1, 'r-01', 'm-01'), line(2, 'r-01', 'm-02'), line(3, 'r-01', 'm-r01-3')]);
    const warn = vi.fn();
    const page = await readPage(project, WORK, 'r-01', { after: 'm-77', fromStart: true, warn });
    expect(page.letters).toEqual([]);
    expect(page.clampedTo).toBe('m-r01-3');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('курсоры', () => {
  it('сессия без файла прочитала «ничего»', async () => {
    expect(await readCursors(project, WORK, 's-03')).toEqual({});
  });

  it('пишется по комнатам и direct, перезаписывается, файлы сессий не мешают друг другу', async () => {
    await writeCursor(project, WORK, 's-03', 'r-01', 'm-r01-412');
    await writeCursor(project, WORK, 's-03', null, 'm-d-17');
    expect(await readCursors(project, WORK, 's-03')).toEqual({ 'r-01': 'm-r01-412', direct: 'm-d-17' });
    await writeCursor(project, WORK, 's-03', 'r-01', 'm-r01-420');
    await writeCursor(project, WORK, 's-04', 'r-01', 'm-r01-1');
    expect(await readCursors(project, WORK, 's-03')).toEqual({ 'r-01': 'm-r01-420', direct: 'm-d-17' });
    expect(await readCursors(project, WORK, 's-04')).toEqual({ 'r-01': 'm-r01-1' });
    expect(workPaths(project, WORK).cursors).toBe(path.join(workPaths(project, WORK).dir, 'cursors'));
  });

  it('человек — читатель со своим курсором: файл human.json', async () => {
    await writeCursor(project, WORK, HUMAN, 'r-01', 'm-r01-5');
    expect(JSON.parse(await readFile(path.join(workPaths(project, WORK).cursors, 'human.json'), 'utf8'))).toEqual({ 'r-01': 'm-r01-5' });
  });

  it('запись курсора — сотни байт, чтение целого файла сессии без догадок о битом файле', async () => {
    await writeCursor(project, WORK, 's-03', 'r-01', 'm-r01-9');
    const file = path.join(workPaths(project, WORK).cursors, 's-03.json');
    expect((await stat(file)).size).toBeLessThan(1024);
    await writeFile(file, '{oborvano');
    const warn = vi.fn();
    expect(await readCursors(project, WORK, 's-03', { warn })).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('unreadFromJournals', () => {
  const room = (extra: Partial<Room> = {}): Room => ({
    id: 'r-01',
    title: 'бэкенд',
    creator: 's-01',
    members: ['s-02', 's-03'],
    createdAt: '2026-10-16T10:00:00.000Z',
    lead: null,
    ...extra,
  } as Room);
  const index = (rooms: Room[]) => ({ schemaVersion: 2 as const, work: {} as never, sessions: [], rooms });
  const letter = (seq: number, roomId: string | null, extra: Partial<Message> = {}) => {
    const rest = {
      seq,
      id: roomId === null ? `m-d-${seq}` : `m-r01-${seq}`,
      roomId,
      from: 's-01',
      to: [] as string[],
      text: `письмо ${seq}`,
      kind: 'note' as const,
      at: `2026-10-16T10:00:${String(seq).padStart(2, '0')}.000Z`,
      ...extra,
    } as Message & { seq: number };
    delete (rest as { readBy?: unknown }).readBy;
    return rest;
  };

  const none = async () => undefined;

  it('письма после курсора, адресованные сессии: рассылка комнаты и прямые', async () => {
    const journals = {
      'r-01': [letter(1, 'r-01'), letter(2, 'r-01'), letter(3, 'r-01', { to: ['s-03'] }), letter(4, 'r-01', { from: 's-02' })],
      direct: [letter(1, null, { to: ['s-02'] }), letter(2, null, { to: ['s-03'] })],
    };
    const got = await unreadFromJournals(index([room()]), journals, { 'r-01': 'm-r01-1' }, 's-02', none);
    // письмо 3 адресовано s-03, письмо 4 — от самой s-02; прямое m-d-1 — ей, курсора direct нет
    expect(got.map((message) => message.id)).toEqual(['m-d-1', 'm-r01-2']);
  });

  it('без курсора комнаты непрочитано всё, что передано; человек не получатель', async () => {
    const journals = { 'r-01': [letter(1, 'r-01')] };
    expect((await unreadFromJournals(index([room()]), journals, {}, 's-03', none)).map((message) => message.id)).toEqual(['m-r01-1']);
    expect(await unreadFromJournals(index([room()]), journals, {}, HUMAN, none)).toEqual([]);
  });

  it('архивная комната адресатов не имеет', async () => {
    const journals = { 'r-01': [letter(1, 'r-01'), letter(2, 'r-01', { to: ['s-02'] })] };
    expect(await unreadFromJournals(index([room({ archivedAt: '2026-10-16T11:00:00.000Z' })]), journals, {}, 's-02', none)).toEqual([]);
  });

  it('отменённое письмо плана непрочитанным не считается', async () => {
    const effect = { roomId: 'r-01', target: 's-02', messageId: 'm-r01-1', text: 'ход', status: 'cancelled' };
    const base = index([room()]);
    const journals = { 'r-01': [letter(1, 'r-01', { from: 'parley', to: ['s-02'], text: 'ход' }), letter(2, 'r-01', { to: ['s-02'] })] };
    const got = await unreadFromJournals({ ...base, planEffects: [effect] } as never, journals, {}, 's-02', none);
    expect(got.map((message) => message.id)).toEqual(['m-r01-2']);
  });

  describe('источник уведомления плана вне загруженного хвоста', () => {
    const live = (id: string, lifecycle = 'live') => ({ id, lifecycle }) as never;
    const base = () => ({
      ...index([room({ lead: 's-02', mode: 'free' } as Partial<Room>)]),
      work: { status: 'active', updatedAt: '2026-10-16T10:00:00.000Z' } as never,
      sessions: [live('s-01'), live('s-02'), live('s-03')],
    });
    const sourceText = 'S01 switched the room to free: тест';
    const noticeText = `Room mode changed. ${sourceText}\nBring a plan matching the current mode before proceeding.`;
    const source = () => letter(1, 'r-01', { from: 'system', to: [HUMAN], text: sourceText, kind: 'system' as never });
    const notice = () => letter(5, 'r-01', { from: 'parley', to: ['s-02'], text: noticeText });
    const effect = {
      key: 'r-01/mode/0/0/mode/m-r01-1/s-02', roomId: 'r-01', planId: null, rev: 0, item: null, kind: 'mode',
      occurrence: 'm-r01-1', target: 's-02', text: noticeText, createdAt: '2026-10-16T10:00:00.000Z', status: 'sent', messageId: 'm-r01-5',
    };

    it('живое уведомление не пропадает, если источник лежит раньше загруженного хвоста', async () => {
      const resolve = vi.fn(async (_room: string, id: string) => (id === 'm-r01-1' ? (source() as never) : undefined));
      const got = await unreadFromJournals({ ...base(), planEffects: [effect] } as never, { 'r-01': [notice()] }, { 'r-01': 'm-r01-4' }, 's-02', resolve);
      expect(got.map((message) => message.id)).toEqual(['m-r01-5']);
      expect(resolve).toHaveBeenCalledWith('r-01', 'm-r01-1');
    });

    it('источник, которого нет и в журнале, значит отменено', async () => {
      const got = await unreadFromJournals({ ...base(), planEffects: [effect] } as never, { 'r-01': [notice()] }, {}, 's-02', none);
      expect(got).toEqual([]);
    });

    it('источник среди загруженных не запрашивается', async () => {
      const resolve = vi.fn(none);
      const got = await unreadFromJournals({ ...base(), planEffects: [effect] } as never, { 'r-01': [source(), notice()] }, { 'r-01': 'm-r01-1' }, 's-02', resolve);
      expect(got.map((message) => message.id)).toEqual(['m-r01-5']);
      expect(resolve).not.toHaveBeenCalled();
    });
  });

  it('порядок: по времени, при равенстве — журнал по ключам, внутри журнала по seq', async () => {
    const same = '2026-10-16T10:00:00.000Z';
    const journals = {
      direct: [letter(1, null, { to: ['s-02'], at: same }), letter(2, null, { to: ['s-02'], at: same })],
      'r-01': [letter(1, 'r-01', { at: '2026-10-16T09:00:00.000Z' }), letter(2, 'r-01', { at: same })],
    };
    const got = await unreadFromJournals(index([room()]), journals, {}, 's-02', none);
    expect(got.map((message) => message.id)).toEqual(['m-r01-1', 'm-d-1', 'm-d-2', 'm-r01-2']);
  });

  it('паритет с unreadFor карты v2 на одной истории', async () => {
    const live = (id: string) => ({ id, lifecycle: 'live' }) as never;
    const sourceText = 'S01 switched the room to free: тест';
    const noticeText = `Room mode changed. ${sourceText}\nBring a plan matching the current mode before proceeding.`;
    const rooms = [
      room({ lead: 's-02', mode: 'free' } as Partial<Room>),
      room({ id: 'r-02', members: ['s-02'], archivedAt: '2026-10-16T09:00:00.000Z' }),
    ];
    const effect = {
      key: 'k', roomId: 'r-01', planId: null, rev: 0, item: null, kind: 'mode', occurrence: 'm-r01-1', target: 's-02',
      text: noticeText, createdAt: '2026-10-16T10:00:00.000Z', status: 'sent', messageId: 'm-r01-6',
    };
    const at = (n: number) => `2026-10-16T10:${String(n).padStart(2, '0')}:00.000Z`;
    const r1 = (seq: number, extra: Partial<Message> = {}) => letter(seq, 'r-01', { at: at(seq), ...extra });
    const history = {
      'r-01': [
        r1(1, { from: 'system', to: [HUMAN], text: sourceText, kind: 'system' as never }), // источник уведомления
        r1(2), // рассылка комнаты из трёх: s-01 пишет, получат s-02 и s-03
        r1(3, { to: ['s-03'] }), // не для s-02
        r1(4, { from: 's-03' }), // рассылка от s-03: s-02 получает
        r1(5, { from: 's-02' }), // свой
        r1(6, { from: 'parley', to: ['s-02'], text: noticeText }), // живое уведомление, источник далеко позади курсора
        r1(7),
      ],
      'r-02': [letter(1, 'r-02', { id: 'm-r02-1', at: at(8), to: ['s-02'] }), letter(2, 'r-02', { id: 'm-r02-2', at: at(9) })], // архив
      direct: [letter(1, null, { to: [HUMAN], at: at(10) }), letter(2, null, { to: ['s-02'], at: at(11) }), letter(3, null, { to: ['s-03'], at: at(12) })],
    };
    const state = { ...base2(), rooms, sessions: [live('s-01'), live('s-02'), live('s-03')], planEffects: [effect] };
    function base2() {
      return { schemaVersion: 2 as const, work: { status: 'active', updatedAt: at(0) } as never };
    }
    const cursors = { 'r-01': 'm-r01-1' };
    // v2: одна лента в порядке записи (по времени), отметки читателя у письма 1 (под курсором)
    const all = [...history['r-01'], ...history['r-02'], ...history.direct].sort((a, b) => (a.at < b.at ? -1 : 1));
    const v2 = { ...state, messages: all.map((row) => {
      const rest = { ...row };
      delete (rest as { seq?: number }).seq;
      return { ...rest, readBy: rest.id === 'm-r01-1' ? { 's-02': at(1) } : {} };
    }) } as unknown as WorkMap;

    const expected = unreadFor(v2, 's-02').map((message) => message.id);
    expect(expected).toEqual(['m-r01-2', 'm-r01-4', 'm-r01-6', 'm-r01-7', 'm-d-2']);

    const resolve = async (roomId: string, id: string) => history['r-01'].find((row) => row.roomId === roomId && row.id === id) as never;
    const tail = { ...history, 'r-01': history['r-01'].slice(1) }; // письмо 1 (источник) в хвост не попало
    const got = await unreadFromJournals(state as never, tail as never, cursors, 's-02', resolve);
    expect(got.map((message) => message.id)).toEqual(expected);
  });
});
