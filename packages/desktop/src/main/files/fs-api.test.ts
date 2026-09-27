import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { WorksSnapshot } from '@harnas/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileRoot } from '../../shared/files-types.js';
import { workKey } from '../../shared/work-keys.js';
import { createRootsRegistry, type RootsRegistry } from '../roots.js';
import { createFsApi } from './fs-api.js';

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
