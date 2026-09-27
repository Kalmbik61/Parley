import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { WorksSnapshot } from '@harnas/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileRoot } from '../shared/files-types.js';
import { workKey } from '../shared/work-keys.js';
import { HostError } from './host-connection.js';
import { createRootsRegistry, FilesDeniedError, relativeInside, type RootsRegistry, type RootsSource } from './roots.js';

/** Сессия фикстуры: `worktree` — путь созданного worktree, `planned` — запланированного (`createdAt: null`). */
interface SessionFixture {
  id: string;
  worktree?: string;
  planned?: string;
}

/** Снимок работ для реестра: реестр читает только `projectPath`, id работы и worktree сессий. */
function snapshot(works: Array<{ projectPath: string; workId: string; sessions?: SessionFixture[] }>): WorksSnapshot {
  return {
    branches: {},
    entries: works.map((work) => ({
      projectPath: work.projectPath,
      map: {
        work: { id: work.workId },
        sessions: (work.sessions ?? []).map((session) => ({
          id: session.id,
          worktree:
            session.worktree !== undefined
              ? { path: session.worktree, branch: 'b', base: 'main', createdAt: '2026-09-27T00:00:00.000Z' }
              : session.planned !== undefined
                ? { path: session.planned, branch: 'b', base: 'main', createdAt: null }
                : null,
        })),
      },
    })),
  } as unknown as WorksSnapshot;
}

/** Подставной источник: `list` отвечает очередью промисов, события шлёт тест. */
function fakeSource(initial: WorksSnapshot | null = null): RootsSource & {
  lists: Array<{ resolve: (s: WorksSnapshot) => void; reject: (e: Error) => void }>;
  auto: WorksSnapshot | null;
  change(s: WorksSnapshot): void;
  connect(): void;
} {
  const changeListeners = new Set<(s: WorksSnapshot) => void>();
  const connectedListeners = new Set<() => void>();
  const source = {
    lists: [] as Array<{ resolve: (s: WorksSnapshot) => void; reject: (e: Error) => void }>,
    auto: initial,
    list: () => {
      if (source.auto !== null) return Promise.resolve(source.auto);
      return new Promise<WorksSnapshot>((resolve, reject) => source.lists.push({ resolve, reject }));
    },
    onChange: (listener: (s: WorksSnapshot) => void) => {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
    onConnected: (listener: () => void) => {
      connectedListeners.add(listener);
      return () => connectedListeners.delete(listener);
    },
    change: (s: WorksSnapshot) => {
      for (const listener of changeListeners) listener(s);
    },
    connect: () => {
      for (const listener of connectedListeners) listener();
    },
  };
  return source;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let dir = '';
let project = '';
const WORK = 'w-1';
const KEY = (): string => workKey(project, WORK);
const PROJECT_ROOT = (): FileRoot => ({ workKey: KEY(), spec: { kind: 'project' } });

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'harnas-roots-'));
  project = path.join(dir, 'proj');
  await mkdir(path.join(project, 'src'), { recursive: true });
  await writeFile(path.join(project, 'src', 'a.ts'), 'a');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Реестр с одной работой в `project` (и её сессиями), уже прочитанный. */
async function ready(sessions: SessionFixture[] = []): Promise<{ registry: RootsRegistry; source: ReturnType<typeof fakeSource> }> {
  const source = fakeSource(snapshot([{ projectPath: project, workId: WORK, sessions }]));
  const registry = createRootsRegistry(source);
  source.connect();
  await vi.waitFor(() => expect(registry.roots(KEY()).length).toBeGreaterThan(0));
  return { registry, source };
}

describe('resolve (тест 1)', () => {
  it('../x, /etc/passwd и NUL — отказ; src/a.ts — путь внутри корня', async () => {
    const { registry } = await ready();
    await expect(registry.resolve(PROJECT_ROOT(), '../x', 'read')).rejects.toBeInstanceOf(FilesDeniedError);
    await expect(registry.resolve(PROJECT_ROOT(), '/etc/passwd', 'read')).rejects.toBeInstanceOf(FilesDeniedError);
    await expect(registry.resolve(PROJECT_ROOT(), 'a\0b', 'read')).rejects.toBeInstanceOf(FilesDeniedError);
    expect(await registry.resolve(PROJECT_ROOT(), 'src/a.ts', 'read')).toBe(
      path.join(await realpath(project), 'src', 'a.ts'),
    );
  });

  it('неизвестный корень — отказ', async () => {
    const { registry } = await ready();
    await expect(
      registry.resolve({ workKey: 'nope', spec: { kind: 'project' } }, 'src/a.ts', 'read'),
    ).rejects.toBeInstanceOf(FilesDeniedError);
    await expect(
      registry.resolve({ workKey: KEY(), spec: { kind: 'worktree', sessionId: 's-09' } }, 'src/a.ts', 'read'),
    ).rejects.toBeInstanceOf(FilesDeniedError);
  });
});

describe('симлинк наружу (тест 2)', () => {
  it('ссылка внутри корня на /etc — чтение через неё отказ', async () => {
    await symlink('/etc', path.join(project, 'etc-link'));
    const { registry } = await ready();
    await expect(registry.resolve(PROJECT_ROOT(), 'etc-link/hosts', 'read')).rejects.toBeInstanceOf(FilesDeniedError);
  });
});

describe('запись и .git (тест 3)', () => {
  it('.git/config, .GIT/config, foo/config при foo → .git — отказ', async () => {
    await mkdir(path.join(project, '.git'));
    await writeFile(path.join(project, '.git', 'config'), '');
    await symlink('.git', path.join(project, 'foo'));
    const { registry } = await ready();
    await expect(registry.resolve(PROJECT_ROOT(), '.git/config', 'write')).rejects.toBeInstanceOf(FilesDeniedError);
    await expect(registry.resolve(PROJECT_ROOT(), '.GIT/config', 'write')).rejects.toBeInstanceOf(FilesDeniedError);
    await expect(registry.resolve(PROJECT_ROOT(), 'foo/config', 'write')).rejects.toBeInstanceOf(FilesDeniedError);
  });

  it('файл .git в корне worktree — запись в него отказ', async () => {
    const worktree = path.join(dir, 'wt');
    await mkdir(worktree);
    await writeFile(path.join(worktree, '.git'), 'gitdir: /elsewhere');
    const { registry } = await ready([{ id: 's-02', worktree }]);
    const root: FileRoot = { workKey: KEY(), spec: { kind: 'worktree', sessionId: 's-02' } };
    await expect(registry.resolve(root, '.git', 'write')).rejects.toBeInstanceOf(FilesDeniedError);
  });

  it('.harnas проекта — запись отказ (спека 10.8, п. 4)', async () => {
    await mkdir(path.join(project, '.harnas'));
    const { registry } = await ready();
    await expect(registry.resolve(PROJECT_ROOT(), '.harnas/works.json', 'write')).rejects.toBeInstanceOf(FilesDeniedError);
    await expect(registry.resolve(PROJECT_ROOT(), '.Harnas/x', 'write')).rejects.toBeInstanceOf(FilesDeniedError);
  });

  it('новый файл src/new.ts при существующем родителе — путь', async () => {
    const { registry } = await ready();
    expect(await registry.resolve(PROJECT_ROOT(), 'src/new.ts', 'write')).toBe(
      path.join(await realpath(project), 'src', 'new.ts'),
    );
  });
});

describe('/tmp и /private/tmp (тест 4)', () => {
  it('корень в /tmp/x: resolve отдаёт realpath, locate(/tmp/x/a) находит корень', async () => {
    const tmpRoot = await mkdtemp('/tmp/harnas-roots-tmp-');
    try {
      await writeFile(path.join(tmpRoot, 'a'), '');
      const source = fakeSource(snapshot([{ projectPath: tmpRoot, workId: WORK }]));
      const registry = createRootsRegistry(source);
      source.connect();
      const key = workKey(tmpRoot, WORK);
      await vi.waitFor(() => expect(registry.roots(key)).toHaveLength(1));
      const real = await realpath(tmpRoot);
      expect(await registry.resolve({ workKey: key, spec: { kind: 'project' } }, 'a', 'read')).toBe(path.join(real, 'a'));
      expect(await registry.locate(key, path.join(tmpRoot, 'a'))).toEqual({
        root: { workKey: key, spec: { kind: 'project' } },
        relPath: 'a',
      });
      // И обратно: путь, напечатанный как realpath, находит корень, записанный через /tmp.
      expect(await registry.locate(key, path.join(real, 'a'))).toEqual({
        root: { workKey: key, spec: { kind: 'project' } },
        relPath: 'a',
      });
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe('works.changed (тест 5)', () => {
  it('после снимка без работы её корень исчезает — resolve отказывает', async () => {
    const { registry, source } = await ready();
    source.change(snapshot([]));
    await vi.waitFor(() => expect(registry.roots(KEY())).toEqual([]));
    await expect(registry.resolve(PROJECT_ROOT(), 'src/a.ts', 'read')).rejects.toBeInstanceOf(FilesDeniedError);
  });
});

describe('запись и симлинки (тест 7)', () => {
  it('висячая ссылка наружу — отказ, файла снаружи нет', async () => {
    const outside = path.join(dir, 'outside');
    await mkdir(outside);
    await symlink(path.join(outside, 'new.ts'), path.join(project, 'a.ts'));
    const { registry } = await ready();
    await expect(registry.resolve(PROJECT_ROOT(), 'a.ts', 'write')).rejects.toBeInstanceOf(FilesDeniedError);
  });

  it('ссылка внутри корня link.ts → real.ts — путь real.ts', async () => {
    await writeFile(path.join(project, 'real.ts'), '');
    await symlink('real.ts', path.join(project, 'link.ts'));
    const { registry } = await ready();
    expect(await registry.resolve(PROJECT_ROOT(), 'link.ts', 'write')).toBe(path.join(await realpath(project), 'real.ts'));
  });

  it('ссылка на существующий файл снаружи — отказ', async () => {
    const outside = path.join(dir, 'outside.ts');
    await writeFile(outside, '');
    await symlink(outside, path.join(project, 'out.ts'));
    const { registry } = await ready();
    await expect(registry.resolve(PROJECT_ROOT(), 'out.ts', 'write')).rejects.toBeInstanceOf(FilesDeniedError);
  });

  it('новый файл в каталоге-ссылке наружу — отказ', async () => {
    const outside = path.join(dir, 'outdir');
    await mkdir(outside);
    await symlink(outside, path.join(project, 'od'));
    const { registry } = await ready();
    await expect(registry.resolve(PROJECT_ROOT(), 'od/new.ts', 'write')).rejects.toBeInstanceOf(FilesDeniedError);
  });
});

describe('locate (тест 8)', () => {
  it('~/x раскрывается по подставному дому', async () => {
    const source = fakeSource(snapshot([{ projectPath: project, workId: WORK }]));
    const registry = createRootsRegistry(source, { home: dir });
    source.connect();
    await vi.waitFor(() => expect(registry.roots(KEY())).toHaveLength(1));
    expect(await registry.locate(KEY(), '~/proj/src/a.ts')).toEqual({ root: PROJECT_ROOT(), relPath: path.join('src', 'a.ts') });
    expect(await registry.insideAnyRoot('~/proj/src/a.ts')).toBe(path.join(await realpath(project), 'src', 'a.ts'));
  });

  it('путь в worktree сессии этой работы внутри папки проекта — корень worktree', async () => {
    const worktree = path.join(project, 'wt');
    await mkdir(worktree);
    await writeFile(path.join(worktree, 'b.ts'), '');
    const { registry } = await ready([{ id: 's-02', worktree }]);
    expect(await registry.locate(KEY(), path.join(worktree, 'b.ts'))).toEqual({
      root: { workKey: KEY(), spec: { kind: 'worktree', sessionId: 's-02' } },
      relPath: 'b.ts',
    });
    // Путь в папке проекта при сессии в worktree — корень проекта.
    expect(await registry.locate(KEY(), path.join(project, 'src', 'a.ts'))).toEqual({
      root: PROJECT_ROOT(),
      relPath: path.join('src', 'a.ts'),
    });
  });

  it('путь вне корней, несуществующий и относительный — null', async () => {
    const { registry } = await ready();
    expect(await registry.locate(KEY(), '/etc/hosts')).toBeNull();
    expect(await registry.locate(KEY(), path.join(project, 'nope.ts'))).toBeNull();
    expect(await registry.locate(KEY(), 'src/a.ts')).toBeNull();
    expect(await registry.insideAnyRoot('/etc/hosts')).toBeNull();
  });

  it('запланированный worktree (createdAt: null) корнем не считается', async () => {
    const { registry } = await ready([{ id: 's-03', planned: path.join(project, 'src') }]);
    expect(registry.roots(KEY()).map((root) => root.spec)).toEqual([{ kind: 'project' }]);
  });
});

describe('две работы одного проекта (тест 9)', () => {
  it('корень ищется только среди корней работы из вызова', async () => {
    const worktreeB = path.join(project, 'wt-b');
    await mkdir(worktreeB);
    await writeFile(path.join(worktreeB, 'c.ts'), '');
    const source = fakeSource(
      snapshot([
        { projectPath: project, workId: 'w-a' },
        { projectPath: project, workId: 'w-b', sessions: [{ id: 's-02', worktree: worktreeB }] },
      ]),
    );
    const registry = createRootsRegistry(source);
    source.connect();
    const a = workKey(project, 'w-a');
    const b = workKey(project, 'w-b');
    await vi.waitFor(() => expect(registry.roots(b)).toHaveLength(2));

    const inProject = path.join(project, 'src', 'a.ts');
    expect((await registry.locate(a, inProject))?.root).toEqual({ workKey: a, spec: { kind: 'project' } });
    expect((await registry.locate(b, inProject))?.root).toEqual({ workKey: b, spec: { kind: 'project' } });

    const inWorktreeB = path.join(worktreeB, 'c.ts');
    expect(await registry.locate(a, inWorktreeB)).toEqual({
      root: { workKey: a, spec: { kind: 'project' } },
      relPath: path.join('wt-b', 'c.ts'),
    });
    expect(await registry.locate(b, inWorktreeB)).toEqual({
      root: { workKey: b, spec: { kind: 'worktree', sessionId: 's-02' } },
      relPath: 'c.ts',
    });
  });
});

describe('подключение к хосту (тест 10)', () => {
  // Отказ list() main пишет в консоль — в выводе тестов он шум.
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('первый list() отклонён — корней нет; onConnected → новый list() — корень есть', async () => {
    const source = fakeSource();
    const registry = createRootsRegistry(source);
    source.connect();
    source.lists[0]?.reject(new Error('socket closed'));
    await sleep(20);
    expect(registry.roots(KEY())).toEqual([]);

    source.connect();
    source.lists[1]?.resolve(snapshot([{ projectPath: project, workId: WORK }]));
    await vi.waitFor(() => expect(registry.roots(KEY())).toHaveLength(1));
  });

  it('отказ следующего list() оставляет прежние корни', async () => {
    const source = fakeSource();
    const registry = createRootsRegistry(source);
    source.connect();
    source.lists[0]?.resolve(snapshot([{ projectPath: project, workId: WORK }]));
    await vi.waitFor(() => expect(registry.roots(KEY())).toHaveLength(1));

    source.connect();
    source.lists[1]?.reject(new Error('socket closed'));
    await sleep(20);
    expect(registry.roots(KEY())).toHaveLength(1);
  });

  it('works.changed во время list() главнее: устаревший ответ его не затирает', async () => {
    const other = path.join(dir, 'other');
    await mkdir(other);
    const source = fakeSource();
    const registry = createRootsRegistry(source);
    source.connect();
    source.change(snapshot([{ projectPath: other, workId: 'w-2' }]));
    await vi.waitFor(() => expect(registry.roots(workKey(other, 'w-2'))).toHaveLength(1));

    source.lists[0]?.resolve(snapshot([{ projectPath: project, workId: WORK }]));
    await sleep(30);
    expect(registry.roots(KEY())).toEqual([]);
    expect(registry.roots(workKey(other, 'w-2'))).toHaveLength(1);
  });
});

describe('удалённый worktree (тест 11)', () => {
  it('корень с упавшим realpath пропущен, остальные на месте', async () => {
    const { registry } = await ready([{ id: 's-02', worktree: path.join(dir, 'gone') }]);
    expect(registry.roots(KEY())).toEqual([{ spec: { kind: 'project' }, absPath: await realpath(project) }]);
  });
});

describe('регистр и форма Unicode (раунд исправлений 1)', () => {
  /** Том tmp нечувствителен к регистру — так на обычной macOS; на чувствительном тест не о чем проверять. */
  const insensitive = async (): Promise<boolean> => {
    const probe = path.join(dir, 'CaseProbe');
    await mkdir(probe);
    try {
      return (await realpath(path.join(dir, 'caseprobe')).then(() => true, () => false));
    } finally {
      await rm(probe, { recursive: true, force: true });
    }
  };

  it('Proj/Src и proj/src на нечувствительном томе — внутри корня', async (ctx) => {
    if (!(await insensitive())) ctx.skip();
    const proj = path.join(dir, 'Proj');
    await mkdir(path.join(proj, 'Src'), { recursive: true });
    await writeFile(path.join(proj, 'Src', 'a.ts'), 'a');
    const source = fakeSource(snapshot([{ projectPath: proj, workId: 'w-c' }]));
    const registry = createRootsRegistry(source);
    source.connect();
    const key = workKey(proj, 'w-c');
    await vi.waitFor(() => expect(registry.roots(key)).toHaveLength(1));

    const lower = path.join(dir, 'proj', 'src', 'a.ts');
    expect(await registry.locate(key, lower)).toEqual({ root: { workKey: key, spec: { kind: 'project' } }, relPath: path.join('src', 'a.ts') });
    expect(await registry.insideAnyRoot(lower)).not.toBeNull();
    expect(await registry.insideAnyRoot(path.join(dir, 'PROJ', 'SRC', 'a.ts'))).not.toBeNull();
    // Соседний каталог с другим именем — снаружи и здесь.
    await mkdir(path.join(dir, 'Proj2'));
    await writeFile(path.join(dir, 'Proj2', 'b.ts'), 'b');
    expect(await registry.locate(key, path.join(dir, 'proj2', 'b.ts'))).toBeNull();
    expect(await registry.insideAnyRoot(path.join(dir, 'Proj2', 'b.ts'))).toBeNull();
  });

  it.runIf(process.platform === 'darwin')('NFD-имя против NFC-корня — внутри корня', async () => {
    const nfc = path.join(dir, 'caf\u00e9');
    await mkdir(nfc);
    await writeFile(path.join(nfc, 'a.ts'), 'a');
    const source = fakeSource(snapshot([{ projectPath: nfc, workId: 'w-u' }]));
    const registry = createRootsRegistry(source);
    source.connect();
    const key = workKey(nfc, 'w-u');
    await vi.waitFor(() => expect(registry.roots(key)).toHaveLength(1));

    const nfd = path.join(dir, 'cafe\u0301', 'a.ts');
    expect(await registry.locate(key, nfd)).toEqual({ root: { workKey: key, spec: { kind: 'project' } }, relPath: 'a.ts' });
    expect(await registry.insideAnyRoot(nfd)).not.toBeNull();
  });

  it('relativeInside: регистр различается только у нечувствительного корня, соседнее имя — снаружи', () => {
    const sensitive = { absPath: '/v/Proj', caseInsensitive: false };
    const folded = { absPath: '/v/Proj', caseInsensitive: true };
    expect(relativeInside(sensitive, '/v/Proj/a.ts')).toBe('a.ts');
    expect(relativeInside(sensitive, '/v/proj/a.ts')).toBeNull();
    expect(relativeInside(folded, '/v/proj/A.ts')).toBe('A.ts');
    expect(relativeInside(folded, '/v/Proj')).toBe('');
    for (const root of [sensitive, folded]) {
      expect(relativeInside(root, '/v/Proj2/a.ts')).toBeNull();
      expect(relativeInside(root, '/v/Project')).toBeNull();
      expect(relativeInside(root, '/v')).toBeNull();
    }
    expect(relativeInside({ absPath: '/v/caf\u00e9', caseInsensitive: false }, '/v/cafe\u0301/x')).toBe('x');
  });
});

describe('ошибки resolve (раунд исправлений 1)', () => {
  it('нет файла при чтении — not_found', async () => {
    const { registry } = await ready();
    const error = await registry.resolve(PROJECT_ROOT(), 'src/nope.ts', 'read').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HostError);
    expect((error as HostError).code).toBe('not_found');
  });

  it('запись при отсутствующем родителе на 2+ уровня — not_found', async () => {
    const { registry } = await ready();
    const error = await registry.resolve(PROJECT_ROOT(), 'new/deeper/file.ts', 'write').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HostError);
    expect((error as HostError).code).toBe('not_found');
  });

  it('ENAMETOOLONG и прочие ошибки realpath — FilesDeniedError', async () => {
    const { registry } = await ready();
    const long = `${'a'.repeat(5000)}/x.ts`;
    await expect(registry.resolve(PROJECT_ROOT(), long, 'read')).rejects.toBeInstanceOf(FilesDeniedError);
    await expect(registry.resolve(PROJECT_ROOT(), long, 'write')).rejects.toBeInstanceOf(FilesDeniedError);
    // ENOTDIR: файл как каталог.
    await expect(registry.resolve(PROJECT_ROOT(), 'src/a.ts/x', 'read')).rejects.toBeInstanceOf(FilesDeniedError);
  });
});
