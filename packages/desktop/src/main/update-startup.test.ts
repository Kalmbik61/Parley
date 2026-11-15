import { spawn, type ChildProcess } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { UpdateResult } from '../shared/bridge.js';
import { helperScript } from './update-helper.js';
import {
  HANDOFF_FILE,
  isProcessAlive,
  nodeStartupFs,
  runUpdateStartup,
  type StartupDeps,
  type StartupFs,
} from './update-startup.js';
import { besideApp, bundleOf, stagingDir, type Bundle } from './update-target.js';

const VERSION = '9.9.9';
const T = 30_000;

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch {
    return false;
  }
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

const dirs: string[] = [];
const children: ChildProcess[] = [];

let deadPid = 0;

beforeAll(async () => {
  const child = spawn('/usr/bin/true', { stdio: 'ignore' });
  deadPid = child.pid!;
  await new Promise((resolve) => child.on('exit', resolve));
});

afterEach(async () => {
  for (const c of children.splice(0)) {
    try {
      process.kill(-c.pid!, 'SIGKILL');
    } catch {
      /* уже нет */
    }
  }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function waitFor(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`не дождались: ${what}`);
}

/** Каталог с приложением, как у человека: пробел, `$` и кавычка в имени не должны ничего раскрывать. */
const ODD = "start $HOME 'q'";

interface Place {
  base: string;
  bundle: Bundle;
  downloads: string;
  result: string;
  old: string;
}

async function makePlace(): Promise<Place> {
  const base = await mkdtemp(path.join(tmpdir(), 'parley-startup-'));
  dirs.push(base);
  const parent = path.join(base, ODD);
  const bundle = bundleOf(path.join(parent, 'Parley.app', 'Contents', 'MacOS', 'Parley'))!;
  await mkdir(path.join(bundle.app, 'Contents', 'MacOS'), { recursive: true });
  await writeFile(path.join(bundle.app, 'Contents', 'MacOS', 'Parley'), 'running');
  const beside = besideApp(bundle);
  const downloads = path.join(base, 'home', 'desktop', 'updates');
  return { base, bundle, downloads, result: beside.result, old: beside.old };
}

async function makeOld(place: Place): Promise<void> {
  await mkdir(path.join(place.old, 'Contents', 'MacOS'), { recursive: true });
  await writeFile(path.join(place.old, 'Contents', 'MacOS', 'Parley'), 'old');
}

interface Harness {
  deps: StartupDeps;
  logs: { message: string; error?: unknown }[];
  /** Ждёт конца фонового удаления (и записи его ошибок в журнал). */
  settle(): Promise<void>;
}

function harness(
  place: Place,
  over: Partial<StartupDeps> = {},
  fs: StartupFs = nodeStartupFs,
): Harness {
  const pending: Promise<unknown>[] = [];
  const logs: Harness['logs'] = [];
  const tracked: StartupFs = {
    ...fs,
    removeTree(target) {
      const p = fs.removeTree(target);
      pending.push(p.then(undefined, () => undefined));
      return p;
    },
  };
  const deps: StartupDeps = {
    bundle: place.bundle,
    version: VERSION,
    pid: process.pid,
    isAlive: () => false,
    downloadsDir: place.downloads,
    fs: tracked,
    log: (message, error) => logs.push({ message, error }),
    ...over,
  };
  return {
    deps,
    logs,
    async settle() {
      await Promise.all(pending);
      // Обработчик ошибки удаления сидит на самом обещании: даём ему отработать.
      await new Promise((r) => setImmediate(r));
    },
  };
}

describe('SU-20: старт окна, итог замены', () => {
  const swapped = `swapped ${VERSION}\n`;

  it('итог своей версии -> «обновлено», .old удалён, файл итога удалён', async () => {
    const place = await makePlace();
    await makeOld(place);
    await writeFile(place.result, swapped);
    const h = harness(place);
    expect(runUpdateStartup(h.deps)).toEqual({ kind: 'updated', version: VERSION });
    await h.settle();
    expect(await exists(place.result)).toBe(false);
    expect(await exists(place.old)).toBe(false);
    expect(await exists(path.join(place.bundle.app, 'Contents', 'MacOS', 'Parley'))).toBe(true);
    expect(h.logs).toEqual([]);
  });

  it('итог без перевода строки читается так же', async () => {
    const place = await makePlace();
    await makeOld(place);
    await writeFile(place.result, `swapped ${VERSION}`);
    const h = harness(place);
    expect(runUpdateStartup(h.deps)).toEqual({ kind: 'updated', version: VERSION });
    await h.settle();
    expect(await exists(place.old)).toBe(false);
  });

  it('launch_failed своей версии: приложение всё-таки запущено -> «обновлено», .old удалён', async () => {
    const place = await makePlace();
    await makeOld(place);
    await writeFile(place.result, `failed ${VERSION} launch_failed\n`);
    const h = harness(place);
    expect(runUpdateStartup(h.deps)).toEqual({ kind: 'updated', version: VERSION });
    await h.settle();
    expect(await exists(place.result)).toBe(false);
    expect(await exists(place.old)).toBe(false);
  });

  it.each(['still_running', 'no_app', 'swap_failed', 'restore_failed', 'helper'] as const)(
    'отказ %s и запущена другая версия -> тост отказа, .old цел, файл итога удалён',
    async (reason) => {
      const place = await makePlace();
      await makeOld(place);
      await writeFile(place.result, `failed 10.0.0 ${reason}\n`);
      const h = harness(place);
      const expected: UpdateResult = { kind: 'failed', version: '10.0.0', reason };
      expect(runUpdateStartup(h.deps)).toEqual(expected);
      await h.settle();
      expect(await exists(place.result)).toBe(false);
      expect(await readText(path.join(place.old, 'Contents', 'MacOS', 'Parley'))).toBe('old');
    },
  );

  it('launch_failed чужой версии -> тост отказа, .old цел', async () => {
    const place = await makePlace();
    await makeOld(place);
    await writeFile(place.result, 'failed 10.0.0 launch_failed\n');
    const h = harness(place);
    expect(runUpdateStartup(h.deps)).toEqual({
      kind: 'failed',
      version: '10.0.0',
      reason: 'launch_failed',
    });
    await h.settle();
    expect(await exists(place.old)).toBe(true);
  });

  it('отказ (не launch_failed) с версией запущенной сборки -> тоста нет, .old цел', async () => {
    const place = await makePlace();
    await makeOld(place);
    await writeFile(place.result, `failed ${VERSION} still_running\n`);
    const h = harness(place);
    expect(runUpdateStartup(h.deps)).toBeNull();
    await h.settle();
    expect(await exists(place.result)).toBe(false);
    expect(await exists(place.old)).toBe(true);
  });

  it.each([
    ['swapped чужой версии', 'swapped 10.0.0\n'],
    ['версия длиннее', 'swapped 9.9.90\n'],
    ['чужая форма', 'swapped\n'],
    ['две строки', `swapped ${VERSION}\nswapped ${VERSION}\n`],
    ['JSON', '{"kind":"updated","version":"9.9.9"}'],
    ['неизвестный код', `failed ${VERSION} busy\n`],
    ['пустой файл', ''],
  ])('%s -> тоста нет, .old цел, файл итога удалён', async (_name, text) => {
    const place = await makePlace();
    await makeOld(place);
    await writeFile(place.result, text);
    const h = harness(place);
    expect(runUpdateStartup(h.deps)).toBeNull();
    await h.settle();
    expect(await exists(place.result)).toBe(false);
    expect(await readText(path.join(place.old, 'Contents', 'MacOS', 'Parley'))).toBe('old');
  });

  it('итога нет -> null, .old цел', async () => {
    const place = await makePlace();
    await makeOld(place);
    const h = harness(place);
    expect(runUpdateStartup(h.deps)).toBeNull();
    await h.settle();
    expect(await exists(place.old)).toBe(true);
    expect(h.logs).toEqual([]);
  });

  it('итог своей версии при отсутствующем .old -> «обновлено», без ошибок', async () => {
    const place = await makePlace();
    await writeFile(place.result, swapped);
    const h = harness(place);
    expect(runUpdateStartup(h.deps)).toEqual({ kind: 'updated', version: VERSION });
    await h.settle();
    expect(h.logs).toEqual([]);
  });

  it('ошибка удаления .old и итога идёт в журнал и наружу не бросается', async () => {
    const place = await makePlace();
    await makeOld(place);
    await writeFile(place.result, swapped);
    const boom = new Error('boom');
    const h = harness(
      place,
      {},
      {
        ...nodeStartupFs,
        removeFile() {
          throw boom;
        },
        removeTree() {
          return Promise.reject(boom);
        },
      },
    );
    expect(runUpdateStartup(h.deps)).toEqual({ kind: 'updated', version: VERSION });
    await h.settle();
    expect(h.logs.map((l) => l.error)).toEqual([boom, boom]);
    expect(h.logs[0]!.message).toContain(place.result);
    expect(h.logs[1]!.message).toContain(place.old);
  });

  it('синхронное исключение удаления тоже уходит в журнал', async () => {
    const place = await makePlace();
    await writeFile(place.result, swapped);
    const boom = new Error('sync boom');
    const h = harness(
      place,
      {},
      {
        ...nodeStartupFs,
        removeTree() {
          throw boom;
        },
      },
    );
    expect(runUpdateStartup(h.deps)).toEqual({ kind: 'updated', version: VERSION });
    expect(h.logs.map((l) => l.error)).toEqual([boom]);
  });

  it('файл итога не читается -> журнал, null, остальное делается', async () => {
    const place = await makePlace();
    await makeOld(place);
    const stale = stagingDir(place.bundle, deadPid, 1);
    await mkdir(stale, { recursive: true });
    const boom = new Error('read boom');
    const h = harness(
      place,
      {},
      {
        ...nodeStartupFs,
        readText() {
          throw boom;
        },
      },
    );
    expect(runUpdateStartup(h.deps)).toBeNull();
    await h.settle();
    expect(h.logs.map((l) => l.error)).toEqual([boom]);
    expect(await exists(place.old)).toBe(true);
    expect(await exists(stale)).toBe(false);
  });
});

describe('SU-21: старт окна, каталоги подготовки и загрузок', () => {
  it('мёртвый pid без handoff и свой pid без handoff удаляются целиком', async () => {
    const place = await makePlace();
    const dead = stagingDir(place.bundle, deadPid, 1);
    const own = stagingDir(place.bundle, process.pid, 2);
    for (const dir of [dead, own]) {
      await mkdir(path.join(dir, 'Parley.app', 'Contents', 'MacOS'), { recursive: true });
      await writeFile(path.join(dir, 'Parley.app', 'Contents', 'MacOS', 'Parley'), 'staged');
      await writeFile(path.join(dir, 'helper.sh'), '#!/bin/sh\n');
    }
    // «Живым» для самого себя считается и свой pid: он удаляется независимо от isAlive.
    const h = harness(place, { isAlive: (pid) => pid === process.pid });
    expect(runUpdateStartup(h.deps)).toBeNull();
    await h.settle();
    expect(await exists(dead)).toBe(false);
    expect(await exists(own)).toBe(false);
    expect(await exists(place.bundle.app)).toBe(true);
  });

  it.each([
    ['пустой handoff', ''],
    ['handoff с содержимым', 'anything\n'],
  ])('мёртвый pid и %s -> каталог цел', async (_name, content) => {
    const place = await makePlace();
    const dir = stagingDir(place.bundle, deadPid, 3);
    await mkdir(path.join(dir, 'Parley.app'), { recursive: true });
    await writeFile(path.join(dir, HANDOFF_FILE), content);
    const h = harness(place);
    runUpdateStartup(h.deps);
    await h.settle();
    expect(await exists(path.join(dir, 'Parley.app'))).toBe(true);
    expect(await readText(path.join(dir, HANDOFF_FILE))).toBe(content);
  });

  it('свой pid и handoff -> каталог цел', async () => {
    const place = await makePlace();
    const dir = stagingDir(place.bundle, process.pid, 4);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, HANDOFF_FILE), '');
    const h = harness(place);
    runUpdateStartup(h.deps);
    await h.settle();
    expect(await exists(dir)).toBe(true);
  });

  it('handoff — висячая ссылка: файл «есть», каталог цел', async () => {
    const place = await makePlace();
    const dir = stagingDir(place.bundle, deadPid, 5);
    await mkdir(dir, { recursive: true });
    await symlink(path.join(place.base, 'no-such-file'), path.join(dir, HANDOFF_FILE));
    const h = harness(place);
    runUpdateStartup(h.deps);
    await h.settle();
    expect(await exists(dir)).toBe(true);
  });

  it('живой чужой pid в имени -> каталог цел, даже без handoff', async () => {
    const place = await makePlace();
    const alive = stagingDir(place.bundle, process.ppid, 6);
    await mkdir(path.join(alive, 'Parley.app'), { recursive: true });
    const asked: number[] = [];
    const h = harness(place, {
      isAlive: (pid) => {
        asked.push(pid);
        return pid === process.ppid;
      },
    });
    runUpdateStartup(h.deps);
    await h.settle();
    expect(await exists(alive)).toBe(true);
    expect(asked).toEqual([process.ppid]);
  });

  it('чужие имена, чужое приложение и не-каталог остаются нетронутыми', async () => {
    const place = await makePlace();
    const keep = [
      path.join(place.bundle.parent, '.Other.app.update-1-1'),
      path.join(place.bundle.parent, `.Parley.app.update-${deadPid}`),
      path.join(place.bundle.parent, `.Parley.app.update-${deadPid}-x`),
      path.join(place.bundle.parent, `Parley.app.update-${deadPid}-1`),
      path.join(place.bundle.parent, 'notes'),
    ];
    for (const dir of keep) await mkdir(dir, { recursive: true });
    const notDir = stagingDir(place.bundle, deadPid, 7);
    await writeFile(notDir, 'file');
    const h = harness(place);
    runUpdateStartup(h.deps);
    await h.settle();
    for (const dir of keep) expect(await exists(dir)).toBe(true);
    expect(await readText(notDir)).toBe('file');
  });

  it('каталог загрузок очищается целиком, сам каталог остаётся', async () => {
    const place = await makePlace();
    await mkdir(path.join(place.downloads, '1'), { recursive: true });
    await writeFile(path.join(place.downloads, '1', 'parley-macos-arm64.zip'), 'zip');
    await mkdir(path.join(place.downloads, '2', 'deep'), { recursive: true });
    await writeFile(path.join(place.downloads, 'stray'), 'x');
    const h = harness(place);
    runUpdateStartup(h.deps);
    await h.settle();
    expect(await exists(place.downloads)).toBe(true);
    expect(await readdir(place.downloads)).toEqual([]);
  });

  it('нет каталога загрузок -> ошибок нет и каталог не создаётся', async () => {
    const place = await makePlace();
    const h = harness(place);
    runUpdateStartup(h.deps);
    await h.settle();
    expect(await exists(place.downloads)).toBe(false);
    expect(h.logs).toEqual([]);
  });

  it('каталог загрузок — ссылка: ничего не удаляется по ней', async () => {
    const place = await makePlace();
    const target = path.join(place.base, 'elsewhere');
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, 'keep'), 'x');
    await mkdir(path.dirname(place.downloads), { recursive: true });
    await symlink(target, place.downloads);
    const h = harness(place);
    runUpdateStartup(h.deps);
    await h.settle();
    expect(await readText(path.join(target, 'keep'))).toBe('x');
  });

  it('ошибка осмотра каталога загрузок идёт в журнал, остальное делается', async () => {
    const place = await makePlace();
    const stale = stagingDir(place.bundle, deadPid, 8);
    await mkdir(stale, { recursive: true });
    const boom = new Error('list boom');
    const h = harness(
      place,
      {},
      {
        ...nodeStartupFs,
        list(dir) {
          if (dir === place.downloads) throw boom;
          return nodeStartupFs.list(dir);
        },
        kind(target) {
          return target === place.downloads ? 'dir' : nodeStartupFs.kind(target);
        },
      },
    );
    runUpdateStartup(h.deps);
    await h.settle();
    expect(h.logs.map((l) => l.error)).toEqual([boom]);
    expect(await exists(stale)).toBe(false);
  });

  it('isProcessAlive: свой pid жив, завершённый и недопустимые — нет', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(deadPid)).toBe(false);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(1.5)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Связка со сценарием замены из U3 на настоящем /bin/sh (спека §6): SU-22 и SU-30. Нужны /usr/bin/lockf macOS,
// поэтому только на darwin (CI — macOS).
// ---------------------------------------------------------------------------------------------------------------

const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

interface Rig extends Place {
  stageDir: string;
  staged: string;
  helper: string;
  openLog: string;
  held: string;
  release: string;
  psOut: string;
}

/**
 * Поддельное приложение (`old`), подготовленное (`new`) с файлом `handoff`, подставные утилиты. `mv` ждёт файла
 * `release` на каждом вызове, пока тест его не создаст; `held` получает pid ждущего `mv`.
 */
async function makeRig(
  opts: { holdMv?: boolean; openCode?: number; psLines?: string[] } = {},
): Promise<Rig> {
  const place = await makePlace();
  await writeFile(path.join(place.bundle.app, 'Contents', 'MacOS', 'Parley'), 'old');
  const stageDir = stagingDir(place.bundle, deadPid, 1);
  const staged = path.join(stageDir, 'Parley.app');
  await mkdir(path.join(staged, 'Contents', 'MacOS'), { recursive: true });
  await writeFile(path.join(staged, 'Contents', 'MacOS', 'Parley'), 'new');
  await writeFile(path.join(stageDir, HANDOFF_FILE), '');
  const tools = path.join(place.base, 'tools');
  await mkdir(tools, { recursive: true });
  const openLog = path.join(tools, 'open.log');
  const held = path.join(tools, 'held');
  const release = path.join(tools, 'release');
  const psOut = path.join(tools, 'ps.out');

  const open = path.join(tools, 'open');
  await writeFile(
    open,
    ['#!/bin/sh', `printf '%s\\n' "$*" >> ${q(openLog)}`, `exit ${opts.openCode ?? 0}`, ''].join(
      '\n',
    ),
  );
  const ps = path.join(tools, 'ps');
  await writeFile(psOut, (opts.psLines ?? []).map((l) => `${l}\n`).join(''));
  await writeFile(ps, ['#!/bin/sh', `/bin/cat ${q(psOut)}`, 'exit 0', ''].join('\n'));
  const mv = path.join(tools, 'mv');
  await writeFile(
    mv,
    [
      '#!/bin/sh',
      ...(opts.holdMv
        ? [`echo $$ > ${q(held)}`, `while [ ! -e ${q(release)} ]; do /bin/sleep 0.1; done`]
        : []),
      'exec /bin/mv "$@"',
      '',
    ].join('\n'),
  );
  await Promise.all([chmod(open, 0o755), chmod(ps, 0o755), chmod(mv, 0o755)]);

  const helper = path.join(stageDir, 'helper.sh');
  await writeFile(helper, helperScript({ waitMs: 300, mv, open, ps }), { mode: 0o700 });
  return { ...place, stageDir, staged, helper, openLog, held, release, psOut };
}

/** Запуск сценария, как у main: `/bin/sh <сценарий> <пять аргументов>`, окно (pid) уже мёртво. */
function startHelper(
  rig: Rig,
  version = VERSION,
): { child: ChildProcess; done: Promise<number | null> } {
  const child = spawn(
    '/bin/sh',
    [rig.helper, String(deadPid), rig.bundle.app, rig.staged, version, rig.result],
    { stdio: 'ignore', detached: true, env: {} },
  );
  children.push(child);
  return { child, done: new Promise((resolve) => child.on('exit', (code) => resolve(code))) };
}

async function marker(app: string): Promise<string | null> {
  return readText(path.join(app, 'Contents', 'MacOS', 'Parley'));
}

describe.skipIf(process.platform !== 'darwin')(
  'связка со сценарием замены на настоящем /bin/sh',
  () => {
    describe('SU-22: итог сценария -> старт окна', () => {
      it(
        'swapped: старт окна с версией из итога даёт «обновлено» и убирает .old',
        async () => {
          const rig = await makeRig();
          expect(await startHelper(rig).done).toBe(0);
          expect(await marker(rig.bundle.app)).toBe('new');
          expect(await marker(rig.old)).toBe('old');
          expect(await readText(rig.result)).toBe(`swapped ${VERSION}\n`);

          const h = harness(rig);
          expect(runUpdateStartup(h.deps)).toEqual({ kind: 'updated', version: VERSION });
          await h.settle();
          expect(await exists(rig.old)).toBe(false);
          expect(await exists(rig.result)).toBe(false);
          expect(await marker(rig.bundle.app)).toBe('new');
          expect(h.logs).toEqual([]);
        },
        T,
      );

      it(
        'launch_failed: open вернул ошибку, но запущена версия из итога -> «обновлено», .old убран',
        async () => {
          const rig = await makeRig({ openCode: 1 });
          expect(await startHelper(rig).done).toBe(0);
          expect(await readText(rig.result)).toBe(`failed ${VERSION} launch_failed\n`);

          const h = harness(rig);
          expect(runUpdateStartup(h.deps)).toEqual({ kind: 'updated', version: VERSION });
          await h.settle();
          expect(await exists(rig.old)).toBe(false);
          expect(await exists(rig.result)).toBe(false);
        },
        T,
      );

      it(
        'still_running: прежнее приложение на месте, запущена прежняя версия -> тост отказа; каталог убрал сценарий',
        async () => {
          const rig = await makeRig();
          // Другой экземпляр того же приложения: его исполняемый файл лежит в <приложение>/Contents/MacOS/.
          await writeFile(rig.psOut, `${rig.bundle.app}/Contents/MacOS/Parley\n`);
          expect(await startHelper(rig).done).toBe(0);
          expect(await readText(rig.result)).toBe(`failed ${VERSION} still_running\n`);
          expect(await marker(rig.bundle.app)).toBe('old');
          expect(await exists(rig.stageDir)).toBe(false);

          const h = harness(rig, { version: '9.9.8' });
          expect(runUpdateStartup(h.deps)).toEqual({
            kind: 'failed',
            version: VERSION,
            reason: 'still_running',
          });
          await h.settle();
          expect(await exists(rig.result)).toBe(false);
          expect(await marker(rig.bundle.app)).toBe('old');
        },
        T,
      );
    });

    describe('SU-30: старт окна внахлёст со сценарием', () => {
      it(
        'сценарий стоит между шагами 3 и 6 (mv ждёт): старт окна каталог не трогает, замена доходит до конца',
        async () => {
          const rig = await makeRig({ holdMv: true });
          const { done } = startHelper(rig);
          await waitFor(() => exists(rig.held), 'mv сценария остановился');

          const h = harness(rig, { version: '9.9.8' });
          expect(runUpdateStartup(h.deps)).toBeNull();
          await h.settle();
          // Каталог подготовки передан сценарию: цел вместе с подготовленным приложением, сценарием и handoff.
          expect(await marker(rig.staged)).toBe('new');
          expect(await exists(rig.helper)).toBe(true);
          expect(await exists(path.join(rig.stageDir, HANDOFF_FILE))).toBe(true);
          expect(await marker(rig.bundle.app)).toBe('old');
          expect(await exists(rig.old)).toBe(false);

          await writeFile(rig.release, '');
          expect(await done).toBe(0);
          expect(await marker(rig.bundle.app)).toBe('new');
          expect(await marker(rig.old)).toBe('old');
          expect(await exists(rig.stageDir)).toBe(false);
          expect(await readText(rig.result)).toBe(`swapped ${VERSION}\n`);

          // Окно новой версии: итог прочитан, .old убран.
          const after = harness(rig);
          expect(runUpdateStartup(after.deps)).toEqual({ kind: 'updated', version: VERSION });
          await after.settle();
          expect(await exists(rig.old)).toBe(false);
        },
        T,
      );

      it(
        'убита только оболочка сценария, дочерний mv жив: старт окна каталог не трогает, ни до, ни после конца mv',
        async () => {
          const rig = await makeRig({ holdMv: true });
          const { child, done } = startHelper(rig);
          await waitFor(() => exists(rig.held), 'mv сценария остановился');
          const mvPid = Number((await readText(rig.held))!.trim());
          expect(isProcessAlive(mvPid)).toBe(true);

          process.kill(child.pid!, 'SIGKILL');
          await done;
          expect(isProcessAlive(mvPid)).toBe(true);

          const during = harness(rig, { version: '9.9.8' });
          expect(runUpdateStartup(during.deps)).toBeNull();
          await during.settle();
          expect(await marker(rig.staged)).toBe('new');
          expect(await exists(path.join(rig.stageDir, HANDOFF_FILE))).toBe(true);
          expect(await marker(rig.bundle.app)).toBe('old');

          // Живой mv доделывает своё переименование: приложения нет, прежнее — в .old.
          await writeFile(rig.release, '');
          await waitFor(() => !isProcessAlive(mvPid), 'конец mv');
          await waitFor(() => exists(rig.old), 'mv переименовал приложение');
          expect(await exists(rig.bundle.app)).toBe(false);

          // Старт окна после этого: тот же каталог, по-прежнему цел, .old цел (итога нет).
          const after = harness(rig, { version: '9.9.8' });
          expect(runUpdateStartup(after.deps)).toBeNull();
          await after.settle();
          expect(await marker(rig.staged)).toBe('new');
          expect(await exists(path.join(rig.stageDir, HANDOFF_FILE))).toBe(true);
          expect(await marker(rig.old)).toBe('old');
          expect(await exists(rig.result)).toBe(false);
        },
        T,
      );
    });
  },
);
