import { spawn, type ChildProcess } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { UpdateResult } from '../shared/bridge.js';
import {
  HELPER_POLL_MS,
  HELPER_TOOLS,
  HELPER_WAIT_MS,
  formatResult,
  helperScript,
  parseResult,
  type HelperOptions,
} from './update-helper.js';
import { besideApp, bundleOf, stagingDir } from './update-target.js';

const VERSION = '9.9.9';
const T = 30_000;

describe('formatResult / parseResult', () => {
  const cases: [UpdateResult, string][] = [
    [{ kind: 'updated', version: '1.2.3' }, 'swapped 1.2.3'],
    [{ kind: 'failed', version: '1.2.3', reason: 'still_running' }, 'failed 1.2.3 still_running'],
    [{ kind: 'failed', version: '10.0.12', reason: 'no_app' }, 'failed 10.0.12 no_app'],
    [{ kind: 'failed', version: '1.2.3', reason: 'swap_failed' }, 'failed 1.2.3 swap_failed'],
    [{ kind: 'failed', version: '1.2.3', reason: 'restore_failed' }, 'failed 1.2.3 restore_failed'],
    [{ kind: 'failed', version: '1.2.3', reason: 'launch_failed' }, 'failed 1.2.3 launch_failed'],
    [{ kind: 'failed', version: '1.2.3', reason: 'helper' }, 'failed 1.2.3 helper'],
  ];

  it.each(cases)('%j <-> %s', (result, line) => {
    expect(formatResult(result)).toBe(line);
    expect(parseResult(line)).toEqual(result);
    expect(parseResult(`${line}\n`)).toEqual(result);
  });

  it.each([
    '',
    '\n',
    'swapped',
    'swapped 1.2',
    'swapped 1.2.3.4',
    'swapped v1.2.3',
    'swapped 1.2.3 extra',
    'swapped  1.2.3',
    ' swapped 1.2.3',
    'swapped 1.2.3\n\n',
    'swapped 1.2.3\r\n',
    'swapped 1.2.3\nfailed 1.2.3 no_app',
    'failed 1.2.3',
    'failed 1.2.3 ',
    'failed 1.2.3 quit_timeout',
    'failed 1.2.3 busy',
    'failed 1.2.3 network',
    'failed 1.2.3 still_running extra',
    'failed x.y.z no_app',
    'updated 1.2.3',
    'SWAPPED 1.2.3',
    '{"kind":"updated","version":"1.2.3"}',
  ])('чужая форма %j -> null', (text) => {
    expect(parseResult(text)).toBeNull();
  });

  it('formatResult не пишет чужую версию и чужой код', () => {
    expect(() => formatResult({ kind: 'updated', version: '1.2' })).toThrow();
    expect(() =>
      formatResult({ kind: 'failed', version: '1.2.3', reason: 'busy' as never }),
    ).toThrow();
  });
});

describe('helperScript', () => {
  it('тело в функции, вызываемой последней строкой', () => {
    const lines = helperScript().trimEnd().split('\n');
    expect(lines[0]).toBe('#!/bin/sh');
    expect(lines[lines.length - 1]).toBe('main "$@"');
  });

  it('значения по умолчанию — константы спеки', () => {
    const text = helperScript();
    expect(HELPER_WAIT_MS).toBe(60_000);
    expect(HELPER_TOOLS).toEqual({
      mv: '/bin/mv',
      rm: '/bin/rm',
      lockf: '/usr/bin/lockf',
      open: '/usr/bin/open',
      ps: '/bin/ps',
      date: '/bin/date',
    });
    expect(text).toContain("MV='/bin/mv'");
    expect(text).toContain("RM='/bin/rm'");
    expect(text).toContain("LOCKF='/usr/bin/lockf'");
    expect(text).toContain("OPEN='/usr/bin/open'");
    expect(text).toContain("PS='/bin/ps'");
    expect(text).toContain("DATE='/bin/date'");
    expect(text).toContain(`TICKS=${HELPER_WAIT_MS / HELPER_POLL_MS}`);
    // Предел по часам — целые секунды (granularity `date +%s`), округление вверх.
    expect(text).toContain(`WAIT_SECS=${HELPER_WAIT_MS / 1000}`);
    expect(helperScript({ waitMs: 300 })).toContain('WAIT_SECS=1');
    expect(helperScript({ waitMs: 1001 })).toContain('WAIT_SECS=2');
  });

  it('сценарий остаётся константным текстом: путь date берётся как у остальных утилит', () => {
    expect(helperScript({ date: "/tmp/it's/date" })).toContain(`DATE='/tmp/it'\\''s/date'`);
    expect(() => helperScript({ date: '' })).toThrow();
  });

  it('замок — дескриптор 9 и lockf -s -t 0 9; open с закрытым дескриптором', () => {
    const text = helperScript();
    expect(text).toContain('9>"$LOCK"');
    expect(text).toContain('"$LOCKF" -s -t 0 9');
    expect(text).toContain('"$OPEN" "$APP" 9>&-');
  });

  it('разбирается оболочкой целиком (sh -n)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'parley-helper-syntax-'));
    try {
      const file = path.join(dir, 'helper.sh');
      await writeFile(file, helperScript());
      const code = await new Promise<number | null>((resolve) => {
        spawn('/bin/sh', ['-n', file], { stdio: 'ignore' }).on('exit', resolve);
      });
      expect(code).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('пути утилит с кавычкой и пробелом остаются одним словом', () => {
    const text = helperScript({ mv: "/tmp/it's a/mv", open: '/tmp/$HOME/open' });
    expect(text).toContain(`MV='/tmp/it'\\''s a/mv'`);
    expect(text).toContain("OPEN='/tmp/$HOME/open'");
  });

  it('отвергает пустой путь утилиты и плохое время ожидания', () => {
    expect(() => helperScript({ rm: '' })).toThrow();
    expect(() => helperScript({ waitMs: -1 })).toThrow();
    expect(() => helperScript({ waitMs: Number.NaN })).toThrow();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Стенд для настоящего /bin/sh (спека §6): поддельное приложение `Parley.app` с `Contents/MacOS/Parley`, подготовленное
// приложение в каталоге подготовки, подставные утилиты рядом. Нужны /usr/bin/lockf и /bin/ps macOS, поэтому набор идёт
// только на darwin (CI — macOS).
// ---------------------------------------------------------------------------------------------------------------

/** Строка в одинарных кавычках для текста подставных утилит. */
const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch {
    return false;
  }
}

async function logLines(file: string): Promise<string[]> {
  const text = await readText(file);
  return text === null ? [] : text.split('\n').filter((l) => l !== '');
}

/** Что лежит в поддельном приложении (`old` / `new` / `stale`) или `null`, если приложения нет. */
function marker(app: string): Promise<string | null> {
  return readText(path.join(app, 'Contents', 'MacOS', 'Parley'));
}

interface WrapperOptions {
  /** Номера вызовов, на которых утилита возвращает 1, ничего не сделав. */
  fail?: number[];
  /** Номера вызовов, на которых утилита возвращает 0, ничего не сделав. */
  noop?: number[];
  /** На этом вызове утилита пишет свой pid в `held` и ждёт файла `release`. */
  hold?: number;
  /** После настоящего вызова с этим номером создаёт каталог; `@app` — путь приложения стенда. */
  mkdirAfter?: { call: number; path: string };
}

interface Rig {
  base: string;
  /** Каталог с приложением (там лежат только файлы, относящиеся к замене). */
  parent: string;
  app: string;
  old: string;
  result: string;
  lock: string;
  stageDir: string;
  staged: string;
  helper: string;
  tools: string;
  openLog: string;
  fdLog: string;
  mvLog: string;
  rmLog: string;
  held: string;
  release: string;
  psOut: string;
  options: HelperOptions;
}

interface RigOptions {
  /** Номер попытки в имени каталога подготовки. */
  n?: number;
  /** Второй сценарий на то же приложение. */
  shareWith?: Rig;
  openCode?: number;
  psLines?: string[];
  psExit?: number;
  /** Свой текст подставного ps (после `#!/bin/sh`) вместо печати `psLines`. */
  psBody?: string[];
  /** Свой текст подставного date (после `#!/bin/sh`) вместо настоящего. */
  dateBody?: string[];
  /** open после записи в журнал ждёт файла `release` (замок при этом держит сценарий). */
  openHold?: boolean;
  mv?: WrapperOptions;
  rm?: WrapperOptions;
  waitMs?: number;
}

const rigs: string[] = [];
const children: ChildProcess[] = [];

/** Имя с пробелом, `$`, кавычкой и `*`: пути приходят аргументами и не должны раскрываться. */
const ODD = "u3 $HOME 'q' [x]*";

async function wrapper(
  file: string,
  real: string,
  log: string,
  rig: Rig,
  opts: WrapperOptions = {},
): Promise<void> {
  const count = `${file}.count`;
  const lines = [
    '#!/bin/sh',
    `n=$(/bin/cat ${q(count)} 2>/dev/null || echo 0)`,
    'n=$((n + 1))',
    `echo "$n" > ${q(count)}`,
    `printf '%s\\n' "$*" >> ${q(log)}`,
    `case " ${(opts.fail ?? []).join(' ')} " in *" $n "*) exit 1 ;; esac`,
    `case " ${(opts.noop ?? []).join(' ')} " in *" $n "*) exit 0 ;; esac`,
  ];
  if (opts.hold !== undefined) {
    lines.push(
      `if [ "$n" = ${opts.hold} ]; then`,
      `  echo $$ > ${q(rig.held)}`,
      `  while [ ! -e ${q(rig.release)} ]; do /bin/sleep 0.1; done`,
      'fi',
    );
  }
  lines.push(`${real} "$@"`, 'rc=$?');
  if (opts.mkdirAfter) {
    const target = opts.mkdirAfter.path === '@app' ? rig.app : opts.mkdirAfter.path;
    lines.push(`[ "$n" = ${opts.mkdirAfter.call} ] && /bin/mkdir -p ${q(target)}`);
  }
  lines.push('exit $rc', '');
  await writeFile(file, lines.join('\n'));
  await chmod(file, 0o755);
}

async function makeRig(opts: RigOptions = {}): Promise<Rig> {
  const base = opts.shareWith?.base ?? (await mkdtemp(path.join(tmpdir(), 'parley-helper-')));
  if (!opts.shareWith) rigs.push(base);
  const n = opts.n ?? 1;
  const parent = path.join(base, ODD);
  const bundle = bundleOf(path.join(parent, 'Parley.app', 'Contents', 'MacOS', 'Parley'))!;
  const beside = besideApp(bundle);
  const stageDir = stagingDir(bundle, 4242, n);
  const tools = path.join(base, `tools-${n}`);
  await mkdir(tools, { recursive: true });
  const rig: Rig = {
    base,
    parent,
    app: bundle.app,
    old: beside.old,
    result: beside.result,
    lock: beside.lock,
    stageDir,
    staged: path.join(stageDir, 'Parley.app'),
    helper: path.join(stageDir, 'helper.sh'),
    tools,
    openLog: path.join(tools, 'open.log'),
    fdLog: path.join(tools, 'fd.log'),
    mvLog: path.join(tools, 'mv.log'),
    rmLog: path.join(tools, 'rm.log'),
    held: path.join(tools, 'held'),
    release: path.join(tools, 'release'),
    psOut: path.join(tools, 'ps.out'),
    options: {},
  };
  if (!opts.shareWith) {
    await mkdir(path.join(rig.app, 'Contents', 'MacOS'), { recursive: true });
    await writeFile(path.join(rig.app, 'Contents', 'MacOS', 'Parley'), 'old');
  }
  await mkdir(path.join(rig.staged, 'Contents', 'MacOS'), { recursive: true });
  await writeFile(path.join(rig.staged, 'Contents', 'MacOS', 'Parley'), 'new');
  await writeFile(path.join(stageDir, 'handoff'), '');

  // open: пишет аргументы и то, открыт ли дескриптор замка; возвращает заданный код.
  const open = path.join(tools, 'open');
  await writeFile(
    open,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> ${q(rig.openLog)}`,
      `if ( : >&9 ) 2>/dev/null; then echo open >> ${q(rig.fdLog)}; else echo closed >> ${q(rig.fdLog)}; fi`,
      ...(opts.openHold
        ? [`echo $$ > ${q(rig.held)}`, `while [ ! -e ${q(rig.release)} ]; do /bin/sleep 0.1; done`]
        : []),
      `exit ${opts.openCode ?? 0}`,
      '',
    ].join('\n'),
  );
  // ps: печатает заданный список (файл можно менять на ходу).
  const ps = path.join(tools, 'ps');
  await writeFile(rig.psOut, (opts.psLines ?? []).map((l) => `${l}\n`).join(''));
  await writeFile(
    ps,
    (opts.psBody
      ? ['#!/bin/sh', ...opts.psBody, '']
      : ['#!/bin/sh', `/bin/cat ${q(rig.psOut)}`, `exit ${opts.psExit ?? 0}`, '']
    ).join('\n'),
  );
  const mv = path.join(tools, 'mv');
  const rmTool = path.join(tools, 'rm');
  await wrapper(mv, '/bin/mv', rig.mvLog, rig, opts.mv);
  await wrapper(rmTool, '/bin/rm', rig.rmLog, rig, opts.rm);
  await chmod(open, 0o755);
  await chmod(ps, 0o755);

  rig.options = { waitMs: opts.waitMs ?? 300, mv, rm: rmTool, open, ps };
  if (opts.dateBody) {
    const date = path.join(tools, 'date');
    await writeFile(date, ['#!/bin/sh', ...opts.dateBody, ''].join('\n'));
    await chmod(date, 0o755);
    rig.options.date = date;
  }
  await writeFile(rig.helper, helperScript(rig.options), { mode: 0o700 });
  return rig;
}

function defaultArgs(rig: Rig, pid: number): string[] {
  return [String(pid), rig.app, rig.staged, VERSION, rig.result];
}

let deadPid = 0;

beforeAll(async () => {
  const child = spawn('/usr/bin/true', { stdio: 'ignore' });
  deadPid = child.pid!;
  await new Promise((resolve) => child.on('exit', resolve));
});

interface Started {
  child: ChildProcess;
  done: Promise<number | null>;
}

/** Запускает сценарий так же, как main: `/bin/sh <сценарий> <пять аргументов>`, без оболочки родителя и PATH. */
function start(rig: Rig, args: string[] = defaultArgs(rig, deadPid)): Started {
  const child = spawn('/bin/sh', [rig.helper, ...args], {
    stdio: 'ignore',
    detached: true,
    env: {},
  });
  children.push(child);
  return { child, done: new Promise((resolve) => child.on('exit', (code) => resolve(code))) };
}

async function run(rig: Rig, args?: string[]): Promise<number | null> {
  return start(rig, args).done;
}

function killGroup(child: ChildProcess): void {
  try {
    process.kill(-child.pid!, 'SIGKILL');
  } catch {
    /* уже нет */
  }
}

afterEach(async () => {
  for (const c of children.splice(0)) killGroup(c);
  for (const base of rigs.splice(0)) await rm(base, { recursive: true, force: true });
});

async function waitFor(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`не дождались: ${what}`);
}

async function waitDead(pid: number): Promise<void> {
  await waitFor(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }, `конец процесса ${pid}`);
}

/** Держатель замка замены: настоящий lockf на том же файле, процесс `sleep` с унаследованным дескриптором. */
async function holdLock(lock: string): Promise<ChildProcess> {
  const holder = spawn(
    '/bin/sh',
    [
      '-c',
      'exec 9>"$1" && /usr/bin/lockf -s -t 0 9 && echo held && exec /bin/sleep 60',
      'sh',
      lock,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'], detached: true, env: {} },
  );
  children.push(holder);
  await new Promise<void>((resolve, reject) => {
    holder.stdout!.once('data', () => resolve());
    holder.on('exit', () => reject(new Error('держатель замка не взял замок')));
  });
  return holder;
}

interface State {
  app: string | null;
  old: string | null;
  staged: string | null;
  stageDir: boolean;
  handoff: boolean;
  result: string | null;
  lockFile: boolean;
  opens: string[];
  fds: string[];
  mvCalls: string[];
  rmCalls: string[];
}

async function state(rig: Rig): Promise<State> {
  return {
    app: await marker(rig.app),
    old: await marker(rig.old),
    staged: await marker(rig.staged),
    stageDir: await exists(rig.stageDir),
    handoff: await exists(path.join(rig.stageDir, 'handoff')),
    result: await readText(rig.result),
    lockFile: await exists(rig.lock),
    opens: await logLines(rig.openLog),
    fds: await logLines(rig.fdLog),
    mvCalls: await logLines(rig.mvLog),
    rmCalls: await logLines(rig.rmLog),
  };
}

/** Каталог приложения без ничего лишнего: в нём только приложение, `.old`, замок и итог. */
async function parentEntries(rig: Rig): Promise<string[]> {
  return (await readdir(rig.parent)).sort();
}

describe.skipIf(process.platform !== 'darwin')('сценарий замены на настоящем /bin/sh', () => {
  // SU-16
  describe('SU-16: успех', () => {
    it(
      'новое на месте, прежнее в .old, каталога подготовки нет, итог swapped, open один раз с путём приложения',
      async () => {
        const rig = await makeRig();
        expect(await run(rig)).toBe(0);
        const s = await state(rig);
        expect(s.app).toBe('new');
        expect(s.old).toBe('old');
        expect(s.stageDir).toBe(false);
        expect(parseResult(s.result!)).toEqual({ kind: 'updated', version: VERSION });
        expect(s.result).toBe(`swapped ${VERSION}\n`);
        expect(s.opens).toEqual([rig.app]);
        // Файл замка остаётся лежать и ничего не содержит.
        expect(s.lockFile).toBe(true);
        expect(await readText(rig.lock)).toBe('');
        expect(await parentEntries(rig)).toEqual(
          [
            path.basename(rig.app),
            path.basename(rig.old),
            path.basename(rig.result),
            path.basename(rig.lock),
          ].sort(),
        );
      },
      T,
    );

    it(
      'open запущен с закрытым дескриптором замка',
      async () => {
        const rig = await makeRig();
        await run(rig);
        expect(await logLines(rig.fdLog)).toEqual(['closed']);
      },
      T,
    );

    it(
      'остаток прежней замены .old убирается, замок, оставшийся от прошлого запуска, не мешает',
      async () => {
        const rig = await makeRig();
        await mkdir(path.join(rig.old, 'Contents', 'MacOS'), { recursive: true });
        await writeFile(path.join(rig.old, 'Contents', 'MacOS', 'Parley'), 'stale');
        await writeFile(rig.lock, 'остаток чужого владельца 123');
        expect(await run(rig)).toBe(0);
        const s = await state(rig);
        expect(s.app).toBe('new');
        expect(s.old).toBe('old');
        expect(s.rmCalls[0]).toBe(`-rf -- ${rig.old}`);
        expect(s.result).toBe(`swapped ${VERSION}\n`);
        expect(await readText(rig.lock)).toBe('');
      },
      T,
    );

    it(
      'ждёт конца процесса окна',
      async () => {
        const rig = await makeRig({ waitMs: 5000 });
        const window = spawn('/bin/sleep', ['0.6'], { stdio: 'ignore' });
        const t0 = Date.now();
        expect(await run(rig, defaultArgs(rig, window.pid!))).toBe(0);
        expect(Date.now() - t0).toBeGreaterThanOrEqual(500);
        expect((await state(rig)).app).toBe('new');
      },
      T,
    );

    it(
      'чужие процессы вне Contents/MacOS/ и с похожим началом замену не держат',
      async () => {
        const rig = await makeRig({ waitMs: 300 });
        await writeFile(
          rig.psOut,
          [
            `${rig.app}x/Contents/MacOS/Parley`,
            `${rig.app}/Contents/Resources/helper`,
            `${rig.app}/Contents/Frameworks/Electron Helper`,
            `/prefix${rig.app}/Contents/MacOS/Parley`,
            `${path.dirname(rig.app)}/.*/Contents/MacOS/Parley`,
            '/usr/bin/true',
            '',
          ].join('\n'),
        );
        expect(await run(rig)).toBe(0);
        expect((await state(rig)).result).toBe(`swapped ${VERSION}\n`);
      },
      T,
    );

    it(
      'другой экземпляр приложения, который успел выйти, замену не срывает',
      async () => {
        const rig = await makeRig({ waitMs: 5000 });
        await writeFile(rig.psOut, `${rig.app}/Contents/MacOS/Parley\n`);
        const t0 = Date.now();
        setTimeout(() => void writeFile(rig.psOut, ''), 500);
        expect(await run(rig)).toBe(0);
        expect(Date.now() - t0).toBeGreaterThanOrEqual(400);
        expect((await state(rig)).app).toBe('new');
      },
      T,
    );
  });

  // SU-17: каждый отказ таблицы §5.5 отдельным случаем — исход, итог, состояние диска, вызовы open
  describe('SU-17: отказы по таблице', () => {
    it(
      'quit_timeout: окно не вышло за предел — ничего не тронуто, итога и замка нет',
      async () => {
        const rig = await makeRig({ waitMs: 300 });
        const t0 = Date.now();
        expect(await run(rig, defaultArgs(rig, process.pid))).toBe(0);
        expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
        expect(await state(rig)).toEqual({
          app: 'old',
          old: null,
          staged: 'new',
          stageDir: true,
          handoff: true,
          result: null,
          lockFile: false,
          opens: [],
          fds: [],
          mvCalls: [],
          rmCalls: [],
        });
      },
      T,
    );

    it(
      'busy: замок занят другим держателем — свой каталог убран, приложение открыто, итога нет',
      async () => {
        const rig = await makeRig();
        await holdLock(rig.lock);
        expect(await run(rig)).toBe(0);
        expect(await state(rig)).toEqual({
          app: 'old',
          old: null,
          staged: null,
          stageDir: false,
          handoff: false,
          result: null,
          lockFile: true,
          opens: [rig.app],
          fds: ['closed'],
          mvCalls: [],
          rmCalls: [`-rf -- ${rig.stageDir}`],
        });
      },
      T,
    );

    it(
      'busy: замок взять не удалось (файл замка не открывается) — то же',
      async () => {
        const rig = await makeRig();
        await mkdir(rig.lock);
        expect(await run(rig)).toBe(0);
        const s = await state(rig);
        expect(s).toMatchObject({
          app: 'old',
          old: null,
          stageDir: false,
          result: null,
          opens: [rig.app],
          mvCalls: [],
          rmCalls: [`-rf -- ${rig.stageDir}`],
        });
      },
      T,
    );

    it(
      'still_running: другой экземпляр приложения не вышел — итог, каталог подготовки убран, прежнее открыто',
      async () => {
        const rig = await makeRig({ waitMs: 300 });
        await writeFile(rig.psOut, `/usr/bin/other\n${rig.app}/Contents/MacOS/Parley\n`);
        expect(await run(rig)).toBe(0);
        expect(await state(rig)).toEqual({
          app: 'old',
          old: null,
          staged: null,
          stageDir: false,
          handoff: false,
          result: `failed ${VERSION} still_running\n`,
          lockFile: true,
          opens: [rig.app],
          fds: ['closed'],
          mvCalls: [],
          rmCalls: [`-rf -- ${rig.stageDir}`],
        });
      },
      T,
    );

    it(
      'still_running: ps не отработал — список неизвестен, считаем, что процесс есть',
      async () => {
        const rig = await makeRig({ waitMs: 300, psExit: 1 });
        expect(await run(rig)).toBe(0);
        const s = await state(rig);
        expect(s.result).toBe(`failed ${VERSION} still_running\n`);
        expect(s.app).toBe('old');
        expect(s.old).toBeNull();
        expect(s.mvCalls).toEqual([]);
      },
      T,
    );

    it(
      'no_app: подготовленного приложения нет, прежнее на месте — итог, каталог убран, прежнее открыто',
      async () => {
        const rig = await makeRig();
        await rm(rig.staged, { recursive: true });
        expect(await run(rig)).toBe(0);
        expect(await state(rig)).toEqual({
          app: 'old',
          old: null,
          staged: null,
          stageDir: false,
          handoff: false,
          result: `failed ${VERSION} no_app\n`,
          lockFile: true,
          opens: [rig.app],
          fds: ['closed'],
          mvCalls: [],
          rmCalls: [`-rf -- ${rig.stageDir}`],
        });
      },
      T,
    );

    it(
      'no_app: прежнего приложения нет — итог; подготовленное не удалено, open не вызван',
      async () => {
        const rig = await makeRig();
        await rm(rig.app, { recursive: true });
        expect(await run(rig)).toBe(0);
        expect(await state(rig)).toEqual({
          app: null,
          old: null,
          staged: 'new',
          stageDir: true,
          handoff: true,
          result: `failed ${VERSION} no_app\n`,
          lockFile: true,
          opens: [],
          fds: [],
          mvCalls: [],
          rmCalls: [],
        });
      },
      T,
    );

    it(
      'swap_failed, шаг 4: остаток .old не удалился — прежнее на месте, остаток цел, каталог убран, прежнее открыто',
      async () => {
        const rig = await makeRig({ rm: { fail: [1] } });
        await mkdir(path.join(rig.old, 'Contents', 'MacOS'), { recursive: true });
        await writeFile(path.join(rig.old, 'Contents', 'MacOS', 'Parley'), 'stale');
        expect(await run(rig)).toBe(0);
        expect(await state(rig)).toEqual({
          app: 'old',
          old: 'stale',
          staged: null,
          stageDir: false,
          handoff: false,
          result: `failed ${VERSION} swap_failed\n`,
          lockFile: true,
          opens: [rig.app],
          fds: ['closed'],
          mvCalls: [],
          rmCalls: [`-rf -- ${rig.old}`, `-rf -- ${rig.stageDir}`],
        });
      },
      T,
    );

    it(
      'swap_failed, шаг 5: приложение не переименовалось в .old — прежнее на месте, каталог убран, прежнее открыто',
      async () => {
        const rig = await makeRig({ mv: { fail: [1] } });
        expect(await run(rig)).toBe(0);
        expect(await state(rig)).toEqual({
          app: 'old',
          old: null,
          staged: null,
          stageDir: false,
          handoff: false,
          result: `failed ${VERSION} swap_failed\n`,
          lockFile: true,
          opens: [rig.app],
          fds: ['closed'],
          mvCalls: [`${rig.app} ${rig.old}`],
          rmCalls: [`-rf -- ${rig.stageDir}`],
        });
      },
      T,
    );

    it(
      'swap_failed, шаг 6: новое не встало на место, прежнее возвращено — прежнее на месте, каталог убран, прежнее открыто',
      async () => {
        const rig = await makeRig({ mv: { fail: [2] } });
        expect(await run(rig)).toBe(0);
        expect(await state(rig)).toEqual({
          app: 'old',
          old: null,
          staged: null,
          stageDir: false,
          handoff: false,
          result: `failed ${VERSION} swap_failed\n`,
          lockFile: true,
          opens: [rig.app],
          fds: ['closed'],
          mvCalls: [`${rig.app} ${rig.old}`, `${rig.staged} ${rig.app}`, `${rig.old} ${rig.app}`],
          rmCalls: [`-rf -- ${rig.stageDir}`],
        });
      },
      T,
    );

    it(
      'restore_failed: возврат не удался — приложения нет, прежнее в .old, новое в каталоге подготовки; ничего не удалено и не открыто',
      async () => {
        const rig = await makeRig({ mv: { fail: [2, 3] } });
        expect(await run(rig)).toBe(0);
        expect(await state(rig)).toEqual({
          app: null,
          old: 'old',
          staged: 'new',
          stageDir: true,
          handoff: true,
          result: `failed ${VERSION} restore_failed\n`,
          lockFile: true,
          opens: [],
          fds: [],
          mvCalls: [`${rig.app} ${rig.old}`, `${rig.staged} ${rig.app}`, `${rig.old} ${rig.app}`],
          rmCalls: [],
        });
      },
      T,
    );

    it(
      'launch_failed: open вернул не ноль — итог launch_failed, новое на месте, прежнее в .old, каталог убран',
      async () => {
        const rig = await makeRig({ openCode: 1 });
        expect(await run(rig)).toBe(0);
        expect(await state(rig)).toEqual({
          app: 'new',
          old: 'old',
          staged: null,
          stageDir: false,
          handoff: false,
          result: `failed ${VERSION} launch_failed\n`,
          lockFile: true,
          opens: [rig.app],
          fds: ['closed'],
          mvCalls: [`${rig.app} ${rig.old}`, `${rig.staged} ${rig.app}`],
          rmCalls: [`-rf -- ${rig.stageDir}`],
        });
      },
      T,
    );
  });

  // R4: предел ожидания по прошедшему времени, включая сами проверки (спека §5.5 шаги 1 и 2, §13 п. 10)
  describe('R4: предел ожидания по часам', () => {
    // Предел 1 с; часы знают целые секунды, значит сценарий кончает не раньше 1 с и не позже ~2 с плюс одна проверка.
    const LIMIT = 1000;
    const UPPER = 3500;

    it(
      'процесс окна не кончается: quit_timeout укладывается в верхнюю границу, ничего не тронуто',
      async () => {
        const rig = await makeRig({ waitMs: LIMIT });
        const t0 = Date.now();
        expect(await run(rig, defaultArgs(rig, process.pid))).toBe(0);
        const elapsed = Date.now() - t0;
        expect(elapsed).toBeGreaterThanOrEqual(LIMIT - 100);
        expect(elapsed).toBeLessThan(UPPER);
        const s = await state(rig);
        expect(s.app).toBe('old');
        expect(s.result).toBeNull();
        expect(s.lockFile).toBe(false);
      },
      T,
    );

    it(
      'часы не читаются (date отказал): работает счёт шагов, ожидание всё равно конечно',
      async () => {
        const rig = await makeRig({ waitMs: LIMIT, dateBody: ['exit 1'] });
        const t0 = Date.now();
        expect(await run(rig, defaultArgs(rig, process.pid))).toBe(0);
        const elapsed = Date.now() - t0;
        expect(elapsed).toBeGreaterThanOrEqual(LIMIT - 100);
        expect(elapsed).toBeLessThan(UPPER);
        expect((await state(rig)).result).toBeNull();
      },
      T,
    );

    it(
      'другой экземпляр не кончается, а проверка идёт 0,5 с: still_running в верхней границе',
      async () => {
        const rig = await makeRig({ waitMs: LIMIT });
        // Путь приложения известен только после makeRig: пишем подставной ps с ним.
        await writeFile(
          rig.options.ps!,
          [
            '#!/bin/sh',
            '/bin/sleep 0.5',
            `printf '%s\\n' ${q(`${rig.app}/Contents/MacOS/Parley`)}`,
            '',
          ].join('\n'),
        );
        const t0 = Date.now();
        expect(await run(rig)).toBe(0);
        const elapsed = Date.now() - t0;
        expect(elapsed).toBeLessThan(UPPER);
        const s = await state(rig);
        expect(s.result).toBe(`failed ${VERSION} still_running\n`);
        expect(s.app).toBe('old');
        expect(s.mvCalls).toEqual([]);
      },
      T,
    );

    it(
      'ps дольше предела (пустой список через 3 с): список не успел — считаем, что процесс есть',
      async () => {
        const rig = await makeRig({ waitMs: LIMIT, psBody: ['/bin/sleep 3', 'exit 0'] });
        const t0 = Date.now();
        expect(await run(rig)).toBe(0);
        expect(Date.now() - t0).toBeLessThan(UPPER);
        const s = await state(rig);
        expect(s.result).toBe(`failed ${VERSION} still_running\n`);
        expect(s.app).toBe('old');
        expect(s.old).toBeNull();
        expect(s.mvCalls).toEqual([]);
      },
      T,
    );

    it(
      'ps завис: оборван, процесс ps кончен, дескриптор замка ему не передан, итог still_running',
      async () => {
        const rig = await makeRig({ waitMs: LIMIT });
        const pidFile = path.join(rig.tools, 'ps.pid');
        const fdFile = path.join(rig.tools, 'ps.fd');
        await writeFile(
          rig.options.ps!,
          [
            '#!/bin/sh',
            `echo $$ > ${q(pidFile)}`,
            `if ( : >&9 ) 2>/dev/null; then echo open > ${q(fdFile)}; else echo closed > ${q(fdFile)}; fi`,
            'exec /bin/sleep 20',
            '',
          ].join('\n'),
        );
        const t0 = Date.now();
        expect(await run(rig)).toBe(0);
        expect(Date.now() - t0).toBeLessThan(UPPER);
        const s = await state(rig);
        expect(s.result).toBe(`failed ${VERSION} still_running\n`);
        expect(s.app).toBe('old');
        expect(s.mvCalls).toEqual([]);
        expect((await readText(fdFile))?.trim()).toBe('closed');
        await waitDead(Number((await readText(pidFile))!.trim()));
      },
      T,
    );

    it(
      'ps завис и держит дочерний процесс: ожидание всё равно конечно',
      async () => {
        const rig = await makeRig({ waitMs: LIMIT, psBody: ['/bin/sleep 20', 'exit 0'] });
        const t0 = Date.now();
        expect(await run(rig)).toBe(0);
        expect(Date.now() - t0).toBeLessThan(UPPER);
        expect((await state(rig)).result).toBe(`failed ${VERSION} still_running\n`);
      },
      T,
    );
  });

  // SU-18: место назначения mv занято — отказ шага, а не вложение каталога
  describe('SU-18: место назначения mv занято', () => {
    it(
      'шаг 5: .old остался после удаления — swap_failed, mv не вызван, ничего не вложено',
      async () => {
        // Подставной rm на первом вызове «успешно» ничего не удаляет: остаток .old остаётся на месте назначения.
        const rig = await makeRig({ rm: { noop: [1] } });
        await mkdir(path.join(rig.old, 'Contents', 'MacOS'), { recursive: true });
        await writeFile(path.join(rig.old, 'Contents', 'MacOS', 'Parley'), 'stale');
        expect(await run(rig)).toBe(0);
        const s = await state(rig);
        expect(s).toMatchObject({
          app: 'old',
          old: 'stale',
          stageDir: false,
          result: `failed ${VERSION} swap_failed\n`,
          opens: [rig.app],
          mvCalls: [],
        });
        expect(await readdir(rig.old)).toEqual(['Contents']);
      },
      T,
    );

    it(
      'шаг 6: место приложения заняло чужое — прежнее не вложено, подготовленное цело, restore_failed',
      async () => {
        // После первого mv (приложение -> .old) место приложения занимает пустой каталог.
        const rig = await makeRig({ mv: { mkdirAfter: { call: 1, path: '@app' } } });
        expect(await run(rig)).toBe(0);
        const s = await state(rig);
        expect(s).toMatchObject({
          old: 'old',
          staged: 'new',
          stageDir: true,
          result: `failed ${VERSION} restore_failed\n`,
          opens: [],
          rmCalls: [],
          // ни переименование подготовленного, ни возврат до mv не дошли
          mvCalls: [`${rig.app} ${rig.old}`],
        });
        expect(await readdir(rig.app)).toEqual([]);
        expect(await readdir(rig.old)).toEqual(['Contents']);
      },
      T,
    );
  });

  // SU-19
  it(
    'SU-19: сценарий убит на шаге ожидания — приложение не тронуто',
    async () => {
      const rig = await makeRig({ waitMs: 60_000 });
      const started = start(rig, defaultArgs(rig, process.pid));
      await new Promise((r) => setTimeout(r, 1500));
      expect(started.child.exitCode).toBeNull();
      killGroup(started.child);
      await started.done;
      expect(await state(rig)).toEqual({
        app: 'old',
        old: null,
        staged: 'new',
        stageDir: true,
        handoff: true,
        result: null,
        lockFile: false,
        opens: [],
        fds: [],
        mvCalls: [],
        rmCalls: [],
      });
      expect(await parentEntries(rig)).toEqual(
        [path.basename(rig.app), path.basename(rig.stageDir)].sort(),
      );
    },
    T,
  );

  // SU-29
  describe('SU-29: замок замены, настоящий lockf', () => {
    it(
      'два сценария на одно приложение: замену делает один, второй отступает с busy и ничего не трогает',
      async () => {
        const a = await makeRig({ n: 1, openHold: true, waitMs: 5000 });
        const b = await makeRig({ n: 2, shareWith: a });
        const runA = start(a);
        // A дошёл до open: замена сделана, итог записан, замок держит оболочка A.
        await waitFor(() => exists(a.held), 'open первого сценария');
        expect(await state(a)).toMatchObject({
          app: 'new',
          old: 'old',
          result: `swapped ${VERSION}\n`,
        });

        expect(await run(b)).toBe(0);
        const sb = await state(b);
        expect(sb).toMatchObject({
          app: 'new',
          old: 'old',
          stageDir: false,
          result: `swapped ${VERSION}\n`,
          opens: [b.app],
          mvCalls: [],
          rmCalls: [`-rf -- ${b.stageDir}`],
        });
        // Каталог подготовки первого сценария второй не трогал.
        expect(await exists(path.join(a.stageDir, 'handoff'))).toBe(true);

        await writeFile(a.release, '');
        expect(await runA.done).toBe(0);
        const sa = await state(a);
        expect(sa).toMatchObject({
          app: 'new',
          old: 'old',
          stageDir: false,
          result: `swapped ${VERSION}\n`,
          opens: [a.app],
        });
      },
      T,
    );

    it(
      'убита только оболочка, а дочерний процесс жив — замок занят; убиты все держатели — замок свободен',
      async () => {
        const a = await makeRig({ n: 1, mv: { hold: 2 }, waitMs: 5000 });
        const runA = start(a);
        await waitFor(() => exists(a.held), 'mv первого сценария');
        const childPid = Number(await readText(a.held));
        // Шаг 5 сделан, шаг 6 держится: приложения нет, прежнее в .old, новое в каталоге подготовки.
        expect(await state(a)).toMatchObject({ app: null, old: 'old', staged: 'new' });

        process.kill(runA.child.pid!, 'SIGKILL');
        await runA.done;
        process.kill(childPid, 0); // дочерний mv жив

        const c = await makeRig({ n: 2, shareWith: a });
        expect(await run(c)).toBe(0);
        expect(await state(c)).toMatchObject({
          app: null,
          old: 'old',
          stageDir: false,
          result: null,
          opens: [a.app],
          mvCalls: [],
        });
        // Каталог убитого сценария остался как был.
        expect(await state(a)).toMatchObject({ staged: 'new', stageDir: true, result: null });

        killGroup(runA.child);
        await waitDead(childPid);
        // Файл замка от прошлого запуска лежит; приложение человек вернул вручную строкой из README.
        expect(await exists(a.lock)).toBe(true);
        await rename(a.old, a.app);

        const d = await makeRig({ n: 3, shareWith: a });
        expect(await run(d)).toBe(0);
        expect(await state(d)).toMatchObject({
          app: 'new',
          old: 'old',
          stageDir: false,
          result: `swapped ${VERSION}\n`,
          opens: [a.app],
        });
      },
      T,
    );
  });

  // Защита от неверного вызова: сценарий удаляет каталоги, поэтому плохие аргументы не должны давать ни одного действия.
  describe('проверка аргументов', () => {
    const mutations: [string, (rig: Rig) => string[]][] = [
      ['четыре аргумента', (r) => defaultArgs(r, deadPid).slice(0, 4)],
      ['шесть аргументов', (r) => [...defaultArgs(r, deadPid), 'x']],
      ['pid 0', (r) => defaultArgs(r, 0)],
      ['pid не число', (r) => ['abc', ...defaultArgs(r, deadPid).slice(1)]],
      ['pid пустой', (r) => ['', ...defaultArgs(r, deadPid).slice(1)]],
      ['версия из двух частей', (r) => withArg(r, 3, '1.2')],
      ['версия с хвостовой точкой', (r) => withArg(r, 3, '1.2.3.')],
      ['версия с командой', (r) => withArg(r, 3, '1.2.3; echo')],
      ['версия с v', (r) => withArg(r, 3, 'v1.2.3')],
      ['версия пустая', (r) => withArg(r, 3, '')],
      ['путь приложения пустой', (r) => withArg(r, 1, '')],
      ['путь приложения относительный', (r) => withArg(r, 1, 'Parley.app')],
      ['путь приложения без .app', (r) => withArg(r, 1, path.join(r.parent, 'Parley'))],
      ['подготовленное — само приложение', (r) => withArg(r, 2, r.app)],
      ['подготовленное — корень', (r) => withArg(r, 2, '/')],
      [
        'подготовленное в чужом каталоге',
        (r) => withArg(r, 2, path.join(r.base, '.Parley.app.update-1-1', 'Parley.app')),
      ],
      [
        'каталог подготовки с чужим именем',
        (r) => withArg(r, 2, path.join(r.parent, '.Other.app.update-1-1', 'Parley.app')),
      ],
      [
        'каталог подготовки без номера',
        (r) => withArg(r, 2, path.join(r.parent, '.Parley.app.update-', 'Parley.app')),
      ],
      ['подготовленное относительное', (r) => withArg(r, 2, 'Parley.app')],
      ['итог относительный', (r) => withArg(r, 4, 'result')],
    ];

    function withArg(rig: Rig, index: number, value: string): string[] {
      const args = defaultArgs(rig, deadPid);
      args[index] = value;
      return args;
    }

    it.each(mutations)(
      '%s: код 64, на диске ничего не тронуто',
      async (_name, mutate) => {
        const rig = await makeRig();
        expect(await run(rig, mutate(rig))).toBe(64);
        expect(await state(rig)).toEqual({
          app: 'old',
          old: null,
          staged: 'new',
          stageDir: true,
          handoff: true,
          result: null,
          lockFile: false,
          opens: [],
          fds: [],
          mvCalls: [],
          rmCalls: [],
        });
      },
      T,
    );
  });
});
