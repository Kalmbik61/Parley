import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readWorks } from './works.js';
import { writeBrief } from './brief.js';
import { addSession } from './map.js';
import { writeMcpConfig } from './mcp-config.js';
import { writeWorkSettings } from './settings-file.js';
import { ensureStateDir, isDirectorySync, stateDir } from './state-dir.js';
import { createWork, readMap, updateMap, workPaths } from './store.js';

const run = promisify(execFile);
const git = (dir: string, ...args: string[]) => run('git', ['-C', dir, ...args]);

let home = '';
let project = '';

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
  process.env.PARLEY_HOME = home;
});

afterEach(async () => {
  delete process.env.PARLEY_HOME;
  await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
});

const exists = async (target: string): Promise<boolean> =>
  stat(target).then(
    () => true,
    () => false,
  );

describe('stateDir — выбор каталога состояния проекта (R5)', () => {
  it('нет ни одного — новый .parley, и ничего не создаётся', async () => {
    expect(stateDir(project)).toBe(path.join(project, '.parley'));
    expect(await readdir(project)).toEqual([]);
  });

  it('есть только прежний .harnas — он', async () => {
    await mkdir(path.join(project, '.harnas'));
    expect(stateDir(project)).toBe(path.join(project, '.harnas'));
  });

  it('есть только .parley — он', async () => {
    await mkdir(path.join(project, '.parley'));
    expect(stateDir(project)).toBe(path.join(project, '.parley'));
  });

  it('есть оба — главнее .parley', async () => {
    await mkdir(path.join(project, '.parley'));
    await mkdir(path.join(project, '.harnas'));
    expect(stateDir(project)).toBe(path.join(project, '.parley'));
  });

  it('файл с именем .parley каталогом не считается: прежний .harnas остаётся', async () => {
    await writeFile(path.join(project, '.parley'), 'файл\n', 'utf8');
    await mkdir(path.join(project, '.harnas'));
    expect(stateDir(project)).toBe(path.join(project, '.harnas'));
  });

  it('символическая ссылка на каталог — каталог (проект, заведённый ссылкой, как раньше)', async () => {
    const target = path.join(project, 'elsewhere');
    await mkdir(target);
    await symlink(target, path.join(project, '.harnas'));
    expect(stateDir(project)).toBe(path.join(project, '.harnas'));
  });

  it('isDirectorySync: каталог — да; файл и отсутствующий путь — нет', async () => {
    await writeFile(path.join(project, 'f'), '', 'utf8');
    expect(isDirectorySync(project)).toBe(true);
    expect(isDirectorySync(path.join(project, 'f'))).toBe(false);
    expect(isDirectorySync(path.join(project, 'нет'))).toBe(false);
  });
});

describe('workPaths идёт за каталогом состояния', () => {
  it('в проекте без каталога состояния — .parley/works/<id>', () => {
    expect(workPaths(project, 'w-0001').dir).toBe(path.join(project, '.parley', 'works', 'w-0001'));
  });

  it('в проекте со старым .harnas — .harnas/works/<id>: тот же проект работает дальше', async () => {
    await mkdir(path.join(project, '.harnas'));
    const paths = workPaths(project, 'w-0001');
    expect(paths.dir).toBe(path.join(project, '.harnas', 'works', 'w-0001'));
    expect(paths.map).toBe(path.join(project, '.harnas', 'works', 'w-0001', 'map.json'));
    expect(paths.settings).toBe(path.join(project, '.harnas', 'works', 'w-0001', 'settings.json'));
  });
});

describe('ensureStateDir — каталог состояния сам прячет себя от git (R5)', () => {
  it('новый .parley получает .gitignore со строкой *', async () => {
    const dir = await ensureStateDir(project);

    expect(dir).toBe(path.join(project, '.parley'));
    expect(await readFile(path.join(dir, '.gitignore'), 'utf8')).toBe('*\n');
  });

  it('повторный вызов .gitignore не переписывает', async () => {
    const dir = await ensureStateDir(project);
    await writeFile(path.join(dir, '.gitignore'), '*\n!keep\n', 'utf8');

    await ensureStateDir(project);
    expect(await readFile(path.join(dir, '.gitignore'), 'utf8')).toBe('*\n!keep\n');
  });

  it('уже существующий .parley не трогается: чужой .gitignore не появляется, прежнего не стирают', async () => {
    await mkdir(path.join(project, '.parley'));

    await ensureStateDir(project);
    expect(await exists(path.join(project, '.parley', '.gitignore'))).toBe(false);
  });

  it('прежний .harnas остаётся как есть: ни .gitignore, ни .parley', async () => {
    await mkdir(path.join(project, '.harnas'));

    const dir = await ensureStateDir(project);

    expect(dir).toBe(path.join(project, '.harnas'));
    expect(await readdir(project)).toEqual(['.harnas']);
    expect(await readdir(dir)).toEqual([]);
  });

  it('проекта ещё нет на диске — создаётся вместе с каталогом', async () => {
    const fresh = path.join(project, 'новый', 'проект');

    await ensureStateDir(fresh);

    expect(await readFile(path.join(fresh, '.parley', '.gitignore'), 'utf8')).toBe('*\n');
  });

  it('параллельные вызовы: один .gitignore со строкой *', async () => {
    await Promise.all(Array.from({ length: 8 }, () => ensureStateDir(project)));

    expect(await readFile(path.join(project, '.parley', '.gitignore'), 'utf8')).toBe('*\n');
  });

  it('`.parley` — файл: вызов отказывает, а не молча пишет мимо', async () => {
    await writeFile(path.join(project, '.parley'), 'файл\n', 'utf8');

    await expect(ensureStateDir(project)).rejects.toThrow();
  });

  it('git не видит созданный .parley: ни в status, ни в add -A, корневой .gitignore не нужен', async () => {
    await run('git', ['init', '-b', 'main', project]);
    await git(project, 'config', 'user.email', 'тест@parley');
    await git(project, 'config', 'user.name', 'тест');
    await writeFile(path.join(project, 'a.txt'), 'a\n', 'utf8');
    await git(project, 'add', 'a.txt');
    await git(project, 'commit', '-m', 'первый');

    await createWork(project, { title: 'Авторизация' });

    expect((await git(project, 'status', '--porcelain', '-uall')).stdout).toBe('');
    await git(project, 'add', '-A');
    expect((await git(project, 'status', '--porcelain')).stdout).toBe('');
  });
});

describe('работа в проекте: новый и прежний каталог состояния', () => {
  it('createWork в проекте без каталога: .parley/works/w-0001 и .parley/.gitignore', async () => {
    await createWork(project, { title: 'Первая' });

    expect(await exists(path.join(project, '.parley', 'works', 'w-0001', 'map.json'))).toBe(true);
    expect(await readFile(path.join(project, '.parley', '.gitignore'), 'utf8')).toBe('*\n');
    expect(await exists(path.join(project, '.harnas'))).toBe(false);
  });

  it('createWork в проекте со старым .harnas: карта ложится туда, .parley не заводится', async () => {
    await mkdir(path.join(project, '.harnas'));

    const map = await createWork(project, { title: 'Первая' });

    expect(await exists(path.join(project, '.harnas', 'works', map.work.id, 'map.json'))).toBe(true);
    expect(await exists(path.join(project, '.parley'))).toBe(false);
    // Прежний каталог остаётся как был: своего .gitignore код в него не кладёт.
    expect(await exists(path.join(project, '.harnas', '.gitignore'))).toBe(false);
  });

  it('карты старого проекта читаются и пишутся на месте: updateMap, readMap, readWorks', async () => {
    await mkdir(path.join(project, '.harnas'));
    const created = await createWork(project, { title: 'Старая' });
    // Индекс потерян (перенос дома): список берётся с диска проекта.
    await rm(path.join(home, 'works-index.json'));

    await updateMap(project, created.work.id, (map) => {
      map.work.goal = 'цель';
    });

    expect((await readMap(project, created.work.id)).work.goal).toBe('цель');
    const listed = await readWorks(project);
    expect(listed.map((entry) => entry.map.work.id)).toEqual([created.work.id]);
    expect(await exists(path.join(project, '.parley'))).toBe(false);
  });

  it('при обоих каталогах главнее .parley (R5): карты прежнего не видны, пока их не перенесли, читатель их не сливает', async () => {
    await mkdir(path.join(project, '.harnas'));
    const old = await createWork(project, { title: 'Старая' });
    await mkdir(path.join(project, '.parley'));
    await rm(path.join(home, 'works-index.json'));

    expect((await readWorks(project)).map((entry) => entry.map.work.id)).toEqual([]);
    expect(await exists(path.join(project, '.harnas', 'works', old.work.id, 'map.json'))).toBe(true);
  });
});

describe('любая запись в каталог состояния, которого нет, заводит его вместе с .gitignore (R5)', () => {
  const selfIgnored = async (): Promise<void> => {
    expect(await readFile(path.join(project, '.parley', '.gitignore'), 'utf8')).toBe('*\n');
    expect(await exists(path.join(project, '.harnas'))).toBe(false);
  };

  it('конфиг MCP сессии', async () => {
    await writeMcpConfig(project, 'w-0042', 's-01');
    await selfIgnored();
  });

  it('файл настроек с хуками', async () => {
    await writeWorkSettings(project, 'w-0042');
    await selfIgnored();
  });

  it('бриф: каталог стёрли вместе с работой, а бриф пишут заново', async () => {
    await createWork(project, { title: 'Первая' });
    const map = await updateMap(project, 'w-0001', (current) => {
      addSession(current, { provider: 'claude', label: 'план', task: 'составить план' });
    });
    await rm(path.join(project, '.parley'), { recursive: true });

    await writeBrief(project, map, 's-01');

    await selfIgnored();
  });

  it('прежний .harnas и здесь остаётся единственным: .parley не заводится', async () => {
    await mkdir(path.join(project, '.harnas'));

    await writeMcpConfig(project, 'w-0042', 's-01');
    await writeWorkSettings(project, 'w-0042');

    expect(await exists(path.join(project, '.parley'))).toBe(false);
    expect(await exists(path.join(project, '.harnas', 'works', 'w-0042', 'mcp', 's-01.json'))).toBe(true);
  });
});
