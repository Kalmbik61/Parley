import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { WorksSnapshot } from '@harnas/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileRoot } from '../../shared/files-types.js';
import { decodeIpcError } from '../../shared/ipc-error.js';
import { workKey } from '../../shared/work-keys.js';
import { createRootsRegistry, type RootsRegistry } from '../roots.js';
import { createFsApi, detectText, LIMITS, writeAtomicPreservingMode } from './fs-api.js';
import { createGitApi, createGitRunner } from './git-api.js';

let dir = '';
let project = '';
let key = '';
let registry: RootsRegistry;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'harnas-fsapi-'));
  project = path.join(dir, 'proj');
  await mkdir(path.join(project, 'src'), { recursive: true });
  await writeFile(path.join(project, 'src', 'a.ts'), 'abc');
  key = workKey(project, 'w-1');
  const snapshot = {
    branches: {},
    entries: [{ projectPath: project, map: { work: { id: 'w-1' }, sessions: [] } }],
  } as unknown as WorksSnapshot;
  registry = createRootsRegistry({
    list: async () => snapshot,
    onChange: () => () => {},
    onConnected: (listener) => {
      listener();
      return () => {};
    },
  });
  await vi.waitFor(() => expect(registry.roots(key)).toHaveLength(1));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('files.stat (тест 6)', () => {
  it('файл → kind file, каталог → dir, нет файла → null, вне корня → null', async () => {
    await writeFile(path.join(dir, 'outside.ts'), '');
    await symlink(path.join(dir, 'outside.ts'), path.join(project, 'out.ts'));
    const root: FileRoot = { workKey: key, spec: { kind: 'project' } };
    const [file, folder, missing, escaped, parent] = await createFsApi(registry).stat(root, [
      'src/a.ts',
      'src',
      'src/nope.ts',
      'out.ts',
      '../outside.ts',
    ]);
    expect(file).toMatchObject({ kind: 'file', size: 3 });
    expect(typeof file?.mtimeMs).toBe('number');
    expect(folder).toMatchObject({ kind: 'dir' });
    expect(missing).toBeNull();
    expect(escaped).toBeNull();
    expect(parent).toBeNull();
  });

  it('неизвестный корень — null на каждый путь, а не отказ пачки', async () => {
    expect(await createFsApi(registry).stat({ workKey: 'nope', spec: { kind: 'project' } }, ['src/a.ts'])).toEqual([null]);
  });
});

describe('files.locate (тест 8)', () => {
  it('locate и stat на каждый путь; вне корней и несуществующий — null', async () => {
    const result = await createFsApi(registry).locate(key, [path.join(project, 'src', 'a.ts'), '/etc/hosts', path.join(project, 'x')]);
    expect(result[0]).toMatchObject({
      root: { workKey: key, spec: { kind: 'project' } },
      relPath: path.join('src', 'a.ts'),
      stat: { kind: 'file', size: 3 },
    });
    expect(result[1]).toBeNull();
    expect(result[2]).toBeNull();
  });
});

const MB = 1024 * 1024;
const ROOT = (): FileRoot => ({ workKey: key, spec: { kind: 'project' } });

/** Код отказа, как его увидит окно; 'resolved' — промис не отказал. */
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return decodeIpcError(error).code;
  }
  return 'resolved';
}

/** Временные файлы записи, оставшиеся в каталоге. */
async function leftovers(folder: string): Promise<string[]> {
  return (await readdir(folder)).filter((name) => name.endsWith('.harnas-tmp'));
}

describe('LIMITS и detectText (кусок 7.1a)', () => {
  it('пределы спеки: 2 МБ правка, 20 МБ чтение', () => {
    expect(LIMITS).toEqual({ editableBytes: 2 * MB, openableBytes: 20 * MB });
  });

  it('NUL в первых 8 КБ — binary; после 8 КБ — нет; строгий UTF-8', () => {
    expect(detectText(Buffer.from([0x61, 0x00, 0x62]))).toEqual({ binary: true, utf8: true });
    expect(detectText(Buffer.concat([Buffer.alloc(8192, 0x61), Buffer.from([0])])).binary).toBe(false);
    expect(detectText(Buffer.from('привет', 'utf8'))).toEqual({ binary: false, utf8: true });
    expect(detectText(Buffer.from([0x63, 0x61, 0x66, 0xe9]))).toEqual({ binary: false, utf8: false });
  });
});

describe('files.list (тест 1)', () => {
  it('без .git, .Git и .harnas; FIFO нет; симлинки с target; ignored: false', async () => {
    const outside = path.join(dir, 'outside');
    await mkdir(outside);
    await mkdir(path.join(project, '.harnas'));
    await mkdir(path.join(project, '.Git'));
    await mkdir(path.join(project, 'sub', '.git'), { recursive: true });
    await writeFile(path.join(project, 'sub', 'b.ts'), 'b');
    await symlink(outside, path.join(project, 'out'));
    await symlink(path.join(project, 'src'), path.join(project, 'linkdir'));
    await symlink('src/a.ts', path.join(project, 'linkfile'));
    await symlink(path.join(dir, 'nope'), path.join(project, 'dangling'));
    execFileSync('mkfifo', [path.join(project, 'pipe')]);

    const api = createFsApi(registry);
    const entries = await api.list(ROOT(), '');
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    expect([...byName.keys()].sort()).toEqual(['dangling', 'linkdir', 'linkfile', 'out', 'src', 'sub']);
    expect(byName.get('src')).toMatchObject({ kind: 'dir', target: null });
    expect(byName.get('out')).toMatchObject({ kind: 'symlink', target: null });
    expect(byName.get('linkdir')).toMatchObject({ kind: 'symlink', target: 'dir' });
    expect(byName.get('linkfile')).toMatchObject({ kind: 'symlink', target: 'file' });
    expect(byName.get('dangling')).toMatchObject({ kind: 'symlink', target: null });
    expect(entries.every((entry) => entry.ignored === false)).toBe(true);

    expect((await api.list(ROOT(), 'sub')).map((entry) => entry.name)).toEqual(['b.ts']);
    const [file] = await api.list(ROOT(), 'src');
    expect(file).toMatchObject({ name: 'a.ts', kind: 'file', size: 3, target: null, ignored: false });
    expect(typeof file?.mtimeMs).toBe('number');
  });

  it('папки нет — not_found; путь к файлу — bad_request', async () => {
    const api = createFsApi(registry);
    expect(await codeOf(api.list(ROOT(), 'nope'))).toBe('not_found');
    expect(await codeOf(api.list(ROOT(), 'src/a.ts'))).toBe('bad_request');
  });
});

describe('files.readText (тест 2)', () => {
  it('обычный текст — utf8, без причины только для чтения', async () => {
    const file = await createFsApi(registry).readText(ROOT(), 'src/a.ts');
    const info = await stat(path.join(project, 'src', 'a.ts'));
    expect(file).toEqual({ text: 'abc', mtimeMs: info.mtimeMs, size: 3, binary: false, utf8: true, readOnlyReason: null });
  });

  it('двоичный (NUL) — binary: true', async () => {
    await writeFile(path.join(project, 'bin'), Buffer.from([0x61, 0x00, 0x62]));
    expect(await createFsApi(registry).readText(ROOT(), 'bin')).toMatchObject({ binary: true, size: 3 });
  });

  it('3 МБ текста — too-large; граница 2 МБ: ровно 2 МБ — правка, +1 байт — только чтение', async () => {
    const api = createFsApi(registry);
    await writeFile(path.join(project, 'big'), 'a'.repeat(3 * MB));
    const big = await api.readText(ROOT(), 'big');
    expect(big).toMatchObject({ readOnlyReason: 'too-large', utf8: true, binary: false, size: 3 * MB });
    expect(big.text).toHaveLength(3 * MB);
    await writeFile(path.join(project, 'edge'), 'a'.repeat(2 * MB));
    expect((await api.readText(ROOT(), 'edge')).readOnlyReason).toBeNull();
    await writeFile(path.join(project, 'edge1'), 'a'.repeat(2 * MB + 1));
    expect((await api.readText(ROOT(), 'edge1')).readOnlyReason).toBe('too-large');
  });

  it('Latin-1 с 0xE9 — utf8: false, not-utf8', async () => {
    await writeFile(path.join(project, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    expect(await createFsApi(registry).readText(ROOT(), 'latin1.txt')).toMatchObject({
      utf8: false,
      readOnlyReason: 'not-utf8',
    });
  });

  it('21 МБ — files:too-large; ровно 20 МБ — читается, 20 МБ + 1 — отказ', async () => {
    const api = createFsApi(registry);
    await writeFile(path.join(project, 'huge'), Buffer.alloc(21 * MB, 0x61));
    expect(await codeOf(api.readText(ROOT(), 'huge'))).toBe('files:too-large');
    await writeFile(path.join(project, 'at20'), Buffer.alloc(20 * MB, 0x61));
    expect((await api.readText(ROOT(), 'at20')).size).toBe(20 * MB);
    await writeFile(path.join(project, 'over20'), Buffer.alloc(20 * MB + 1, 0x61));
    expect(await codeOf(api.readText(ROOT(), 'over20'))).toBe('files:too-large');
  });

  it('файла нет — not_found', async () => {
    expect(await codeOf(createFsApi(registry).readText(ROOT(), 'src/nope.ts'))).toBe('not_found');
  });
});

describe('files.readBytes', () => {
  it('байты файла; предел limit включительно', async () => {
    const api = createFsApi(registry);
    expect(Buffer.from(await api.readBytes(ROOT(), 'src/a.ts')).toString()).toBe('abc');
    expect(Buffer.from(await api.readBytes(ROOT(), 'src/a.ts', 3)).toString()).toBe('abc');
    expect(await codeOf(api.readBytes(ROOT(), 'src/a.ts', 2))).toBe('files:too-large');
    expect(await codeOf(api.readBytes(ROOT(), 'src/nope.ts'))).toBe('not_found');
  });
});

describe('FIFO в корне (тест 3)', () => {
  it('readText и readBytes — bad_request быстрее секунды, без писателя', async () => {
    execFileSync('mkfifo', [path.join(project, 'pipe')]);
    const api = createFsApi(registry);
    const started = Date.now();
    expect(await codeOf(api.readText(ROOT(), 'pipe'))).toBe('bad_request');
    expect(await codeOf(api.readBytes(ROOT(), 'pipe'))).toBe('bad_request');
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('files.write (тест 4)', () => {
  it('совпавший mtime — запись, права прежние, mtimeMs ответа — с диска', async () => {
    const target = path.join(project, 'src', 'a.ts');
    await chmod(target, 0o755);
    const before = await stat(target);
    const result = await createFsApi(registry).write(ROOT(), 'src/a.ts', 'new', before.mtimeMs);
    const after = await stat(target);
    expect(result).toEqual({ ok: true, mtimeMs: after.mtimeMs });
    expect(await readFile(target, 'utf8')).toBe('new');
    expect(after.mode & 0o777).toBe(0o755);
    expect(await leftovers(path.join(project, 'src'))).toEqual([]);
  });

  it('имя на 255 байт (предел APFS), латиница и кириллица — запись удалась, временного не осталось (fix-7-accept)', async () => {
    // Временное имя — «.имя.xxxxxxxx.harnas-tmp»: с полным именем цели оно вылезало за 255 байт — ENAMETOOLONG.
    for (const name of [`${'s'.repeat(252)}.ts`, `${'я'.repeat(126)}.ts`]) {
      expect(Buffer.byteLength(name)).toBeLessThanOrEqual(255);
      const target = path.join(project, 'src', name);
      await writeFile(target, 'old');
      const before = await stat(target);
      const result = await createFsApi(registry).write(ROOT(), `src/${name}`, 'new', before.mtimeMs);
      expect(result).toMatchObject({ ok: true });
      expect(await readFile(target, 'utf8')).toBe('new');
    }
    expect(await leftovers(path.join(project, 'src'))).toEqual([]);
  });

  it('устаревший mtime — conflict с mtime диска, файл не изменён', async () => {
    const target = path.join(project, 'src', 'a.ts');
    const before = await stat(target);
    const result = await createFsApi(registry).write(ROOT(), 'src/a.ts', 'new', before.mtimeMs - 1000);
    expect(result).toEqual({ ok: false, conflict: { mtimeMs: before.mtimeMs } });
    expect(await readFile(target, 'utf8')).toBe('abc');
  });

  it('expectedMtimeMs: null — новый файл 0644; файл уже есть — conflict', async () => {
    const api = createFsApi(registry);
    const result = await api.write(ROOT(), 'src/new.ts', 'hello', null);
    const info = await stat(path.join(project, 'src', 'new.ts'));
    expect(result).toEqual({ ok: true, mtimeMs: info.mtimeMs });
    expect(info.mode & 0o777).toBe(0o644);
    expect(await readFile(path.join(project, 'src', 'new.ts'), 'utf8')).toBe('hello');

    const existing = await stat(path.join(project, 'src', 'a.ts'));
    expect(await api.write(ROOT(), 'src/a.ts', 'x', null)).toEqual({ ok: false, conflict: { mtimeMs: existing.mtimeMs } });
    expect(await readFile(path.join(project, 'src', 'a.ts'), 'utf8')).toBe('abc');
    expect(await leftovers(path.join(project, 'src'))).toEqual([]);
  });

  it('файла нет, а ждали mtime — not_found, файл не создан', async () => {
    expect(await codeOf(createFsApi(registry).write(ROOT(), 'src/gone.ts', 'x', 123))).toBe('not_found');
    await expect(stat(path.join(project, 'src', 'gone.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('путь — каталог — bad_request', async () => {
    const info = await stat(path.join(project, 'src'));
    expect(await codeOf(createFsApi(registry).write(ROOT(), 'src', 'x', info.mtimeMs))).toBe('bad_request');
  });
});

describe('очередь записи (тест 5)', () => {
  it('две записи без await с одним mtime — первая ok, вторая conflict, на диске текст первой', async () => {
    const api = createFsApi(registry);
    const { mtimeMs } = await stat(path.join(project, 'src', 'a.ts'));
    const [first, second] = await Promise.all([
      api.write(ROOT(), 'src/a.ts', 'first', mtimeMs),
      api.write(ROOT(), 'src/a.ts', 'second', mtimeMs),
    ]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(await readFile(path.join(project, 'src', 'a.ts'), 'utf8')).toBe('first');
  });
});

describe('путь вне корня (тест 6)', () => {
  it('../x в любом вызове — files:denied', async () => {
    const api = createFsApi(registry);
    expect(await codeOf(api.list(ROOT(), '../x'))).toBe('files:denied');
    expect(await codeOf(api.readText(ROOT(), '../x'))).toBe('files:denied');
    expect(await codeOf(api.readBytes(ROOT(), '../x'))).toBe('files:denied');
    expect(await codeOf(api.write(ROOT(), '../x', 't', null))).toBe('files:denied');
    await expect(stat(path.join(dir, 'x'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('запись через симлинк (тест 7)', () => {
  it('висячая ссылка наружу — files:denied, снаружи файла нет', async () => {
    await mkdir(path.join(dir, 'outside'));
    const outsideFile = path.join(dir, 'outside', 'x');
    await symlink(outsideFile, path.join(project, 'a2.ts'));
    expect(await codeOf(createFsApi(registry).write(ROOT(), 'a2.ts', 'evil', null))).toBe('files:denied');
    await expect(stat(outsideFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('ссылка внутри корня — изменена цель, ссылка осталась ссылкой', async () => {
    const link = path.join(project, 'link.ts');
    await symlink('src/a.ts', link);
    const { mtimeMs } = await stat(path.join(project, 'src', 'a.ts'));
    expect((await createFsApi(registry).write(ROOT(), 'link.ts', 'via link', mtimeMs)).ok).toBe(true);
    expect(await readFile(path.join(project, 'src', 'a.ts'), 'utf8')).toBe('via link');
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
  });
});

describe('подложенное временное имя (тест 8)', () => {
  it('по имени временного файла — симлинк наружу: ошибка, снаружи и цель не изменены', async () => {
    await mkdir(path.join(dir, 'outside'));
    const outsideFile = path.join(dir, 'outside', 'x');
    await writeFile(outsideFile, 'outside');
    const trap = path.join(project, 'src', '.a.ts.deadbeef.harnas-tmp');
    await symlink(outsideFile, trap);
    const api = createFsApi(registry, { random: () => 'deadbeef' });
    const { mtimeMs } = await stat(path.join(project, 'src', 'a.ts'));
    expect(await codeOf(api.write(ROOT(), 'src/a.ts', 'evil', mtimeMs))).toBe('files:denied');
    expect(await readFile(outsideFile, 'utf8')).toBe('outside');
    expect(await readFile(path.join(project, 'src', 'a.ts'), 'utf8')).toBe('abc');
    // Чужой файл по занятому имени запись не удаляет: он не её.
    expect((await lstat(trap)).isSymbolicLink()).toBe(true);
  });

  it('имя временного файла берётся из random; после записи его нет', async () => {
    const seen: string[] = [];
    const target = path.join(await realpath(project), 'src', 'a.ts');
    await writeAtomicPreservingMode(target, 'x', () => {
      const name = 'cafe0123';
      seen.push(name);
      return name;
    });
    expect(seen).toEqual(['cafe0123']);
    expect(await readFile(target, 'utf8')).toBe('x');
    expect(await leftovers(path.join(project, 'src'))).toEqual([]);
  });
});

describe('подмена родителя (тест 9)', () => {
  it('src/ заменён ссылкой наружу после resolve — files:denied, временных файлов нет, снаружи не изменено', async () => {
    const real = await registry.resolve(ROOT(), 'src/a.ts', 'write');
    const outside = path.join(dir, 'outside-src');
    await mkdir(outside);
    await writeFile(path.join(outside, 'keep.txt'), 'keep');
    await rename(path.join(project, 'src'), path.join(project, 'src-old'));
    await symlink(outside, path.join(project, 'src'));

    expect(await codeOf(writeAtomicPreservingMode(real, 'evil'))).toBe('files:denied');
    expect((await readdir(outside)).sort()).toEqual(['keep.txt']);
    expect(await readFile(path.join(outside, 'keep.txt'), 'utf8')).toBe('keep');
    expect(await leftovers(project)).toEqual([]);
    expect(await readdir(path.join(project, 'src-old'))).toEqual(['a.ts']);
    expect(await readFile(path.join(project, 'src-old', 'a.ts'), 'utf8')).toBe('abc');
  });
});

describe('.git и .harnas (тест 10)', () => {
  it('write(.GIT/config) и write(.harnas/works/w/map.json) — files:denied', async () => {
    await mkdir(path.join(project, '.harnas', 'works', 'w'), { recursive: true });
    await writeFile(path.join(project, '.harnas', 'works', 'w', 'map.json'), '{}');
    const api = createFsApi(registry);
    expect(await codeOf(api.write(ROOT(), '.GIT/config', 'x', null))).toBe('files:denied');
    expect(await codeOf(api.write(ROOT(), '.harnas/works/w/map.json', 'x', null))).toBe('files:denied');
    expect(await readFile(path.join(project, '.harnas', 'works', 'w', 'map.json'), 'utf8')).toBe('{}');
  });

  it('list не показывает ссылки, чья цель в .git или .harnas корня; обычные ссылки — показывает (раунд fix-7.1b, п.6)', async () => {
    await mkdir(path.join(project, '.harnas', 'works', 'w'), { recursive: true });
    await writeFile(path.join(project, '.harnas', 'works', 'w', 'map.json'), '{}');
    await mkdir(path.join(project, '.git'));
    await writeFile(path.join(project, '.git', 'config'), '');
    await symlink(path.join(project, '.harnas', 'works', 'w', 'map.json'), path.join(project, 'link.json'));
    await symlink('.harnas', path.join(project, 'harnas-dir'));
    await symlink('.git/config', path.join(project, 'git-config'));
    await symlink('../.harnas/works/w/map.json', path.join(project, 'src', 'deep.json'));
    await symlink('src/a.ts', path.join(project, 'linkfile'));
    await symlink('a.ts', path.join(project, 'src', 'near.ts'));
    const api = createFsApi(registry);
    expect((await api.list(ROOT(), '')).map((e) => e.name).sort()).toEqual(['linkfile', 'src']);
    expect((await api.list(ROOT(), 'src')).map((e) => e.name).sort()).toEqual(['a.ts', 'near.ts']);
    // Чтение `.harnas` через files.* разрешено: скрытие навигационное (решение контролёра).
    expect((await api.readText(ROOT(), 'link.json')).text).toBe('{}');
  });
});

describe('раунд исправлений 1 (кусок 7.1a)', () => {
  it('агент пишет между сверкой mtime и rename — conflict с mtime диска, правка агента цела', async () => {
    const target = path.join(project, 'src', 'a.ts');
    const before = await stat(target);
    // random зовётся уже после первой сверки mtime — ровно окно, где раньше запись агента терялась.
    const api = createFsApi(registry, {
      random: () => {
        writeFileSync(target, 'AGENT WROTE THIS');
        return 'race0001';
      },
    });
    const result = await api.write(ROOT(), 'src/a.ts', 'WINDOW WROTE THIS', before.mtimeMs);
    const now = await stat(target);
    expect(result).toEqual({ ok: false, conflict: { mtimeMs: now.mtimeMs } });
    expect(await readFile(target, 'utf8')).toBe('AGENT WROTE THIS');
    expect(await leftovers(path.join(project, 'src'))).toEqual([]);
  });

  it('новый файл: агент создал его между сверкой и rename — conflict, файл агента цел', async () => {
    const target = path.join(project, 'src', 'new.ts');
    const api = createFsApi(registry, {
      random: () => {
        writeFileSync(target, 'agent');
        return 'race0002';
      },
    });
    const result = await api.write(ROOT(), 'src/new.ts', 'window', null);
    expect(result).toEqual({ ok: false, conflict: { mtimeMs: (await stat(target)).mtimeMs } });
    expect(await readFile(target, 'utf8')).toBe('agent');
    expect(await leftovers(path.join(project, 'src'))).toEqual([]);
  });

  it('цель стала каталогом между сверкой и rename — bad_request, каталог и временных файлов нет', async () => {
    const target = path.join(project, 'src', 'new.ts');
    const api = createFsApi(registry, {
      random: () => {
        mkdirSync(target);
        return 'race0003';
      },
    });
    expect(await codeOf(api.write(ROOT(), 'src/new.ts', 'window', null))).toBe('bad_request');
    expect((await stat(target)).isDirectory()).toBe(true);
    expect(await leftovers(path.join(project, 'src'))).toEqual([]);
  });

  it('режим файла сохраняется целиком, со старшими битами (setuid)', async () => {
    const target = path.join(project, 'src', 'a.ts');
    await chmod(target, 0o4755);
    const before = await stat(target);
    expect(before.mode & 0o7777).toBe(0o4755);
    expect((await createFsApi(registry).write(ROOT(), 'src/a.ts', 'new', before.mtimeMs)).ok).toBe(true);
    expect((await stat(target)).mode & 0o7777).toBe(0o4755);
  });

  it('BOM и CRLF туда-обратно: readText → write → байты те же', async () => {
    const target = path.join(project, 'src', 'crlf.ts');
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('первая\r\nвторая\r\n', 'utf8')]);
    await writeFile(target, bytes);
    const api = createFsApi(registry);
    const file = await api.readText(ROOT(), 'src/crlf.ts');
    expect(file).toMatchObject({ utf8: true, binary: false, readOnlyReason: null });
    expect((await api.write(ROOT(), 'src/crlf.ts', file.text, file.mtimeMs)).ok).toBe(true);
    expect(Buffer.compare(await readFile(target), bytes)).toBe(0);
  });

  it('list по пути-симлинку на каталог внутри корня — содержимое цели', async () => {
    await symlink(path.join(project, 'src'), path.join(project, 'linkdir'));
    const entries = await createFsApi(registry).list(ROOT(), 'linkdir');
    expect(entries.map((entry) => entry.name)).toEqual(['a.ts']);
    expect(entries[0]).toMatchObject({ kind: 'file', size: 3, target: null });
  });
});

describe('files.list: ignored по git check-ignore (кусок 7.1b, тест 1)', () => {
  it('файл и папка из .gitignore — ignored: true; папка без игнорируемых — все false, без ошибки', async () => {
    execFileSync('git', ['init', '-q'], { cwd: project });
    await writeFile(path.join(project, '.gitignore'), '*.log\nbuild/\n');
    await writeFile(path.join(project, 'debug.log'), '');
    await mkdir(path.join(project, 'build'));
    const git = createGitApi({
      git: createGitRunner(process.env),
      roots: registry,
      spawnWorker: () => {
        throw new Error('воркер list не нужен');
      },
    });
    const api = createFsApi(registry, { checkIgnored: git.checkIgnored });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const byName = new Map((await api.list(ROOT(), '')).map((entry) => [entry.name, entry.ignored]));
    expect(Object.fromEntries(byName)).toEqual({ '.gitignore': false, 'debug.log': true, build: true, src: false });
    // В src игнорируемых нет: check-ignore выходит с 1 — это не ошибка.
    expect((await api.list(ROOT(), 'src')).map((entry) => entry.ignored)).toEqual([false]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('checkIgnored отказал — ignored: false у всех и предупреждение', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const api = createFsApi(registry, { checkIgnored: async () => Promise.reject(new Error('boom')) });
    expect((await api.list(ROOT(), 'src')).map((entry) => entry.ignored)).toEqual([false]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('работа создана, works.changed до реестра не дошёл (раунд main-r2, п. 6)', () => {
  it('первый list, readText и locate нового корня проходят без отказа', async () => {
    const fresh = path.join(dir, 'fresh');
    await mkdir(fresh);
    await writeFile(path.join(fresh, 'n.ts'), 'new');
    let current = { branches: {}, entries: [{ projectPath: project, map: { work: { id: 'w-1' }, sessions: [] } }] } as unknown as WorksSnapshot;
    const stale = createRootsRegistry({
      list: async () => current,
      onChange: () => () => {},
      onConnected: (listener) => {
        listener();
        return () => {};
      },
    });
    await vi.waitFor(() => expect(stale.roots(key)).toHaveLength(1));
    // Хост уже знает новую работу; событие works.changed реестру ещё не пришло.
    current = {
      branches: {},
      entries: [
        { projectPath: project, map: { work: { id: 'w-1' }, sessions: [] } },
        { projectPath: fresh, map: { work: { id: 'w-2' }, sessions: [] } },
      ],
    } as unknown as WorksSnapshot;
    const freshKey = workKey(fresh, 'w-2');
    const root: FileRoot = { workKey: freshKey, spec: { kind: 'project' } };
    const api = createFsApi(stale);
    expect((await api.list(root, '')).map((entry) => entry.name)).toEqual(['n.ts']);
    expect((await api.readText(root, 'n.ts')).text).toBe('new');
    const [located] = await api.locate(freshKey, [path.join(fresh, 'n.ts')]);
    expect(located?.relPath).toBe('n.ts');
  });
});
