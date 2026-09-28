import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiffNote, NotesFile } from '../shared/notes-types.js';
import { createNotesStore, notesPath } from './notes-store.js';

const WORK = '/tmp/proj w-0003';

function note(overrides: Partial<DiffNote> = {}): DiffNote {
  return {
    id: '0a1b2c3d',
    path: 'src/a.ts',
    side: 'modified',
    startLine: 7,
    endLine: 7,
    body: 'first line\nsecond line',
    createdAt: '2026-09-27T14:05:01.000Z',
    updatedAt: '2026-09-27T14:05:01.000Z',
    sentAt: null,
    sentTo: null,
    anchor: { text: 'const a = 1;' },
    stale: false,
    ...overrides,
  };
}

/** Все файлы под каталогом — рекурсивно, относительными путями. */
async function listAll(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .sort();
}

describe('notesPath (кусок 8.4a, тест 7)', () => {
  it('~/.harnas/desktop/notes/<sha1(workKey)>/<sessionId>.json', () => {
    const sha1 = createHash('sha1').update(WORK).digest('hex');
    expect(notesPath('/h', WORK, 's-02')).toBe(path.join('/h', 'desktop', 'notes', sha1, 's-02.json'));
  });

  it('sessionId не isSessionId и workKey не isValidWorkKey — ошибка', () => {
    for (const sessionId of ['../x', 's-1/../../x', 'S-01', '']) {
      expect(() => notesPath('/h', WORK, sessionId), sessionId).toThrow();
    }
    for (const workKey of ['__proto__', 'k'.repeat(4097), '']) {
      expect(() => notesPath('/h', workKey, 's-01'), workKey.slice(0, 20)).toThrow();
    }
  });
});

describe('createNotesStore (кусок 8.4a, тест 3)', () => {
  let home: string;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'hh-notes-'));
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    warn.mockRestore();
    await rm(home, { recursive: true, force: true });
  });

  it('файла нет → пустые заметки без corruptedTo', async () => {
    const store = createNotesStore(home);
    await expect(store.load(WORK, 's-01')).resolves.toEqual({ file: { version: 1, notes: [] }, corruptedTo: null });
  });

  it('туда и обратно: save, затем load отдаёт то же; переводы строк целы', async () => {
    const store = createNotesStore(home);
    const saved: NotesFile = { version: 1, notes: [note(), note({ id: 'ffffffff', side: 'original', sentAt: '2026-09-27T14:06:00.000Z', sentTo: 's-02' })] };
    await store.save(WORK, 's-02', saved);
    await expect(store.load(WORK, 's-02')).resolves.toEqual({ file: saved, corruptedTo: null });
    // Файл — ровно там, где говорит notesPath, и других нет.
    expect(await listAll(home)).toEqual([path.relative(home, notesPath(home, WORK, 's-02'))]);
  });

  it('две записи подряд без await — на диске последняя, обе промиса успешны', async () => {
    const store = createNotesStore(home);
    const first: NotesFile = { version: 1, notes: [note({ body: 'one' })] };
    const second: NotesFile = { version: 1, notes: [note({ body: 'two' })] };
    await Promise.all([store.save(WORK, 's-01', first), store.save(WORK, 's-01', second)]);
    await expect(store.load(WORK, 's-01')).resolves.toEqual({ file: second, corruptedTo: null });
  });

  async function expectCorrupted(content: string | Buffer): Promise<void> {
    const file = notesPath(home, WORK, 's-02');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
    const store = createNotesStore(home);

    const result = await store.load(WORK, 's-02');

    expect(result.file).toEqual({ version: 1, notes: [] });
    expect(result.corruptedTo).toMatch(/^s-02\.corrupt-\d{8}-\d{6}\.json$/);
    // В рендерер уходит только имя, без каталога: путь notes/ лежит вне корней работы (спека 15.2).
    expect(result.corruptedTo).not.toContain(path.sep);
    const names = await readdir(path.dirname(file));
    expect(names).toEqual([result.corruptedTo]);
    expect(await readFile(path.join(path.dirname(file), result.corruptedTo ?? ''))).toEqual(Buffer.from(content));
    // Полный путь — в консоль main.
    const warned = warn.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(warned).toContain(path.join(path.dirname(file), result.corruptedTo ?? ''));
  }

  it('битый JSON → пустые заметки, файл *.corrupt-* рядом, corruptedTo — имя, путь — в console.warn', async () => {
    await expectCorrupted('{ not json');
  });

  it('JSON не той формы → битый', async () => {
    await expectCorrupted(JSON.stringify({ version: 1, notes: [note({ body: '' })] }));
  });

  it('файл больше 1 МБ → битый, даже если это верная форма с лишними пробелами', async () => {
    const valid = JSON.stringify({ version: 1, notes: [note()] });
    await expectCorrupted(valid + ' '.repeat(1024 * 1024));
  });

  it('после битого файла save пишет новый, а переименованный остаётся', async () => {
    const file = notesPath(home, WORK, 's-02');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, 'garbage');
    const store = createNotesStore(home);
    const { corruptedTo } = await store.load(WORK, 's-02');
    await store.save(WORK, 's-02', { version: 1, notes: [note()] });
    expect((await readdir(path.dirname(file))).sort()).toEqual([corruptedTo, 's-02.json'].sort());
  });

  it('save с неверной формой или ключами — отказ, файл не пишется', async () => {
    const store = createNotesStore(home);
    await expect(store.save(WORK, 's-01', { version: 1, notes: [note({ body: '' })] })).rejects.toThrow();
    await expect(store.save(WORK, '../x', { version: 1, notes: [] })).rejects.toThrow();
    await expect(store.save('__proto__', 's-01', { version: 1, notes: [] })).rejects.toThrow();
    await expect(store.load(WORK, 's-1/../../x')).rejects.toThrow();
    expect(await listAll(home)).toEqual([]);
  });
});
