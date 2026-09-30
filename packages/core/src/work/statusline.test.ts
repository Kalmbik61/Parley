/**
 * Скрипт строки статуса Claude Code (спека комнат Organic, 3.5): кладёт `rate_limits` в файл
 * работы и печатает строку терминала. Вход — JSON со stdin по документации
 * code.claude.com/docs/en/statusline; настоящие `claude` и `codex` не запускаются, а
 * «команда человека» здесь — обычные `printf`, `cat` и `sleep`.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  STATUSLINE_BIN,
  STATUSLINE_ENTRY,
  isOwnCommand,
  runStatusline,
  statusLineCommand,
} from './statusline.js';

const require = createRequire(import.meta.url);
const tsxLoader = pathToFileURL(require.resolve('tsx')).href;
const binScript = fileURLToPath(new URL(`./${STATUSLINE_BIN}.ts`, import.meta.url));

const NOW = Date.parse('2026-09-29T12:00:00.000Z');
const NOW_SEC = NOW / 1000;
const rateLimits = {
  five_hour: { used_percentage: 58, resets_at: NOW_SEC + 3600 },
  seven_day: { used_percentage: 41.2, resets_at: NOW_SEC + 86_400 },
};

let root = '';
let home = '';
let project = '';
let workDir = '';
let env: NodeJS.ProcessEnv = {};

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'parley-statusline-'));
  home = path.join(root, 'home');
  project = path.join(root, 'project');
  workDir = path.join(root, 'work');
  await Promise.all([home, project, workDir].map((dir) => mkdir(dir)));
  // Окружение процесса агента: адрес работы и сессии, как у хуков; PATH нужен командам человека.
  env = { PATH: process.env['PATH'], HARNAS_WORK_DIR: workDir, HARNAS_SESSION_ID: 's-01' };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Вход Claude Code: модель, каталоги, контекст и лимиты подписки. */
const input = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    model: { id: 'claude-opus-5-5', display_name: 'Opus' },
    workspace: { current_dir: project, project_dir: project },
    context_window: { used_percentage: 8.4 },
    rate_limits: rateLimits,
    ...over,
  });

/** Настройки Claude Code человека: своя строка статуса командой `command` в файле `file`. */
const putStatusLine = async (dir: string, file: string, command: string): Promise<void> => {
  await mkdir(path.join(dir, '.claude'), { recursive: true });
  await writeFile(
    path.join(dir, '.claude', file),
    JSON.stringify({ statusLine: { type: 'command', command } }),
    'utf8',
  );
};

const run = async (
  raw: string,
  options: Parameters<typeof runStatusline>[1] = {},
): Promise<string> =>
  (await runStatusline(raw, { env, home, now: () => NOW, ...options })).toString('utf8');

/** Жив ли процесс: убитый, но не подобранный родителем (зомби) считается мёртвым. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
    return !state.trim().startsWith('Z');
  } catch {
    return false;
  }
}

/** Есть ли процесс с такой командной строкой (`pgrep -f`). */
function hasProcess(pattern: string): boolean {
  try {
    execFileSync('pgrep', ['-f', pattern], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Ждёт, пока условие не выполнится; иначе — ошибка теста, а не зависание. */
async function until(
  condition: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`не дождались: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** pid из файла, который записал внутренний `sh` составной команды (см. `compound`). */
async function sleeperPid(file: string): Promise<number> {
  let pid = 0;
  await until(
    async () => {
      pid = Number((await readFile(file, 'utf8').catch(() => '')).trim());
      return pid > 0;
    },
    'pid внутреннего процесса команды человека',
    15_000,
  );
  return pid;
}

/**
 * Составная команда человека: внешняя оболочка (её запускает скрипт) порождает внутренний `sh`,
 * тот записывает свой pid и становится `sleep`. Убить одну внешнюю оболочку мало: `sleep`
 * переживёт её и продолжит держать унаследованные stdout и stderr.
 */
const compound = (pidFile: string): string =>
  `sh -c 'echo $$ > "${pidFile}"; exec sleep 30'; echo x`;

const limitsFile = path.join('limits', 's-01.json');
const exists = async (file: string): Promise<boolean> =>
  stat(file).then(
    () => true,
    () => false,
  );

describe('файл лимитов', () => {
  it('rate_limits во входе → limits/<сессия>.json с { at, rateLimits }, как пришло', async () => {
    await run(input());

    const written = JSON.parse(await readFile(path.join(workDir, limitsFile), 'utf8')) as unknown;
    expect(written).toEqual({ at: '2026-09-29T12:00:00.000Z', rateLimits });
  });

  it('второй вызов перезаписывает файл, временных файлов рядом не остаётся', async () => {
    await run(input());
    await run(
      input({ rate_limits: { five_hour: { used_percentage: 61, resets_at: NOW_SEC + 3000 } } }),
    );

    expect(await readdir(path.join(workDir, 'limits'))).toEqual(['s-01.json']);
    const written = JSON.parse(await readFile(path.join(workDir, limitsFile), 'utf8')) as {
      rateLimits: { five_hour: { used_percentage: number } };
    };
    expect(written.rateLimits.five_hour.used_percentage).toBe(61);
  });

  it('без rate_limits файл не пишется и каталог limits не заводится', async () => {
    const withoutLimits = JSON.parse(input()) as Record<string, unknown>;
    delete withoutLimits['rate_limits'];
    await run(JSON.stringify(withoutLimits));

    expect(await exists(path.join(workDir, 'limits'))).toBe(false);
  });

  it('rate_limits без окон подписки (только spend_limit шлюза) — тоже не пишется', async () => {
    await run(
      input({ rate_limits: { spend_limit: { used_percentage: 130, resets_at: NOW_SEC } } }),
    );
    await run(input({ rate_limits: {} }));
    await run(input({ rate_limits: null }));

    expect(await exists(path.join(workDir, 'limits'))).toBe(false);
  });

  it('нет адреса в окружении или id сессии негодный — файла нет, строка есть', async () => {
    for (const bad of [
      { HARNAS_SESSION_ID: '../evil' },
      { HARNAS_SESSION_ID: '' },
      { HARNAS_WORK_DIR: 'work' },
      { HARNAS_WORK_DIR: undefined },
    ]) {
      const line = await run(input(), { env: { ...env, ...bad } });
      expect(line).toContain('Opus');
    }
    expect(await readdir(workDir)).toEqual([]);
    expect(await exists(path.join(root, 'evil.json'))).toBe(false);
  });

  it('каталога работы нет (работу удалили под живым агентом): строка есть, каталог не воскресает', async () => {
    await rm(workDir, { recursive: true });

    const line = await run(input());

    expect(line).toBe('Opus · ctx 8%\n');
    expect(await exists(workDir)).toBe(false);
  });
});

describe('строка терминала', () => {
  it('своего statusLine у человека нет — короткая строка: модель и процент контекста', async () => {
    expect(await run(input())).toBe('Opus · ctx 8%\n');
  });

  it('нет процента контекста или модели — остаётся что есть; совсем ничего — всё равно строка', async () => {
    expect(await run(input({ context_window: { used_percentage: null } }))).toBe('Opus\n');
    expect(await run(input({ model: { id: 'claude-opus-5-5' } }))).toBe(
      'claude-opus-5-5 · ctx 8%\n',
    );
    expect(await run(input({ model: null, context_window: null }))).toBe('Claude\n');
  });

  it('битый stdin: строка есть, ошибки нет, файл не пишется', async () => {
    for (const raw of ['', 'не json', '{"model":', '[1,2]', 'null']) {
      expect(await run(raw)).toBe('Claude\n');
    }
    expect(await exists(path.join(workDir, 'limits'))).toBe(false);
  });

  it('statusLine человека: его вывод — как есть, без добавленного перевода строки', async () => {
    await putStatusLine(home, 'settings.json', "printf 'мой статус'");

    expect(await run(input())).toBe('мой статус');
    // Файл лимитов при этом пишется: строка человека одно, данные окна — другое.
    expect(await exists(path.join(workDir, limitsFile))).toBe(true);
  });

  it('команда человека получает тот же stdin и то же окружение', async () => {
    await putStatusLine(home, 'settings.json', 'cat');
    const raw = input();
    expect(await run(raw)).toBe(raw);

    await putStatusLine(home, 'settings.json', 'echo "$HARNAS_SESSION_ID $HARNAS_WORK_DIR"');
    expect(await run(raw)).toBe(`s-01 ${workDir}\n`);
  });

  it('порядок старшинства: локальные настройки проекта, общие проекта, пользователя', async () => {
    await putStatusLine(project, 'settings.local.json', "printf 'локальная'");
    await putStatusLine(project, 'settings.json', "printf 'проектная'");
    await putStatusLine(home, 'settings.json', "printf 'пользовательская'");

    expect(await run(input())).toBe('локальная');
    await rm(path.join(project, '.claude', 'settings.local.json'));
    expect(await run(input())).toBe('проектная');
    await rm(path.join(project, '.claude', 'settings.json'));
    expect(await run(input())).toBe('пользовательская');
    await rm(path.join(home, '.claude', 'settings.json'));
    expect(await run(input())).toBe('Opus · ctx 8%\n');
  });

  it('файл настроек битый или без команды-строки статуса — ищется дальше', async () => {
    await mkdir(path.join(project, '.claude'), { recursive: true });
    await writeFile(path.join(project, '.claude', 'settings.local.json'), '{ битый', 'utf8');
    await writeFile(
      path.join(project, '.claude', 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command' }, permissions: {} }),
      'utf8',
    );
    await putStatusLine(home, 'settings.json', "printf 'пользовательская'");

    expect(await run(input())).toBe('пользовательская');
  });

  it('проект — project_dir, куда запущен Claude Code; настройки каталога, куда ушёл агент, не берутся', async () => {
    const inner = path.join(project, 'src');
    await mkdir(inner);
    const marker = path.join(root, 'чужая-команда-вызвана');
    await putStatusLine(project, 'settings.json', "printf 'проектная'");
    // Чужой репозиторий внутри проекта (клон, vendored-пакет) со своей строкой статуса: Claude Code её
    // не читает, значит, и нам исполнять её нельзя — это обход доверия к папке.
    await putStatusLine(inner, 'settings.json', `touch '${marker}'; printf 'подкаталог'`);
    const drifted = { workspace: { current_dir: inner, project_dir: project } };

    expect(await run(input(drifted))).toBe('проектная');
    // В проекте своей строки нет — настройки подкаталога всё равно не берутся, дальше пользователь.
    await rm(path.join(project, '.claude'), { recursive: true });
    await putStatusLine(home, 'settings.json', "printf 'пользовательская'");
    expect(await run(input(drifted))).toBe('пользовательская');
    expect(await exists(marker)).toBe(false);
  });

  it('старый Claude Code без project_dir: проект — current_dir; нет ни того ни другого — только настройки пользователя', async () => {
    await putStatusLine(project, 'settings.json', "printf 'проектная'");
    await putStatusLine(home, 'settings.json', "printf 'пользовательская'");

    expect(await run(input({ workspace: { current_dir: project } }))).toBe('проектная');
    expect(await run(input({ workspace: undefined, cwd: project }))).toBe('проектная');
    // Каталога проекта во входе нет (битый вход): каталог процесса не угадывается, проект не читается.
    expect(await run(input({ workspace: undefined }))).toBe('пользовательская');
    expect(await run('не json')).toBe('пользовательская');
  });

  it('наш же скрипт в настройках человека не зовётся: короткая строка вместо рекурсии', async () => {
    const marker = path.join(root, 'called');
    // Команда с полным путём нашего скрипта, оставляющая след, если её всё-таки вызвали.
    await putStatusLine(home, 'settings.json', `touch '${marker}'; echo '${STATUSLINE_ENTRY}'`);

    expect(await run(input())).toBe('Opus · ctx 8%\n');
    expect(await exists(marker)).toBe(false);
  });

  it('чужой скрипт с похожим именем — не наш: вызывается, а не заменяется короткой строкой', async () => {
    // Свой скрипт человека, названный `statusline-bin`, — не повод его пропускать.
    const script = path.join(home, 'bin', STATUSLINE_BIN);
    await mkdir(path.dirname(script), { recursive: true });
    await writeFile(script, "#!/bin/sh\nprintf 'мой скрипт'\n", { mode: 0o755 });
    await putStatusLine(home, 'settings.json', script);
    expect(await run(input())).toBe('мой скрипт');

    await putStatusLine(home, 'settings.json', `echo /x/work/${STATUSLINE_BIN}.js`);
    expect(await run(input())).toBe(`/x/work/${STATUSLINE_BIN}.js\n`);
    await putStatusLine(home, 'settings.json', `printf 'заметки-${STATUSLINE_BIN}'`);
    expect(await run(input())).toBe(`заметки-${STATUSLINE_BIN}`);
  });

  it('команда человека упала — короткая строка, а не пустота', async () => {
    await putStatusLine(home, 'settings.json', 'echo частичный вывод; exit 3');
    expect(await run(input())).toBe('Opus · ctx 8%\n');

    await putStatusLine(home, 'settings.json', 'команды-с-таким-именем-нет 2>/dev/null');
    expect(await run(input())).toBe('Opus · ctx 8%\n');
  });

  it('команда человека зависла — короткая строка по таймауту, скрипт не ждёт её конца', async () => {
    await putStatusLine(home, 'settings.json', 'sleep 5');

    const started = Date.now();
    const line = await run(input(), { humanTimeoutMs: 150 });

    expect(line).toBe('Opus · ctx 8%\n');
    expect(Date.now() - started).toBeLessThan(2500);
    // Файл лимитов записан до вызова команды: и зависшая, и убитая Claude Code строка его не теряет.
    expect(await exists(path.join(workDir, limitsFile))).toBe(true);
  });

  it('составная команда зависла: по таймауту убивается вся группа процессов, а не только оболочка', async () => {
    const pidFile = path.join(root, 'sleeper.pid');
    await putStatusLine(home, 'settings.json', compound(pidFile));

    // Предел щедрый: под нагрузкой две оболочки подряд запускаются не мгновенно.
    const started = Date.now();
    const pending = run(input(), { humanTimeoutMs: 2000 });
    const pid = await sleeperPid(pidFile);
    try {
      expect(await pending).toBe('Opus · ctx 8%\n');
      expect(Date.now() - started).toBeLessThan(8000);
      // Внутренний процесс — не сама оболочка: без группы он пережил бы её и держал stderr.
      await until(() => !alive(pid), 'процесс команды человека убит вместе с группой', 3000);
    } finally {
      if (alive(pid)) process.kill(pid, 'SIGKILL');
    }
  }, 20_000);

  it('составная `sleep 5; echo x` с малым таймаутом: строка короткая, а `sleep` из группы не остаётся', async () => {
    // Своя длительность и якоря в шаблоне: `pgrep -f` не должен спутать этот `sleep` с чужим
    // процессом, в чьей командной строке просто упомянута такая команда.
    await putStatusLine(home, 'settings.json', 'sleep 5.317; echo x');
    const sleeping = '^sleep 5\\.317$';

    const line = run(input(), { humanTimeoutMs: 2000 });
    await until(() => hasProcess(sleeping), 'sleep запущен', 10_000);

    expect(await line).toBe('Opus · ctx 8%\n');
    await until(() => !hasProcess(sleeping), 'sleep убит вместе с группой', 3000);
  }, 20_000);

  it('отмена (signal): команда человека убивается с группой, строка короткая; отменено до запуска — команда не стартует', async () => {
    const pidFile = path.join(root, 'sleeper.pid');
    await putStatusLine(home, 'settings.json', compound(pidFile));

    const cancel = new AbortController();
    const pending = run(input(), { signal: cancel.signal });
    const pid = await sleeperPid(pidFile);
    try {
      cancel.abort();
      expect(await pending).toBe('Opus · ctx 8%\n');
      await until(() => !alive(pid), 'процесс команды человека убит вместе с группой', 3000);
    } finally {
      if (alive(pid)) process.kill(pid, 'SIGKILL');
    }

    const marker = path.join(root, 'started');
    await putStatusLine(home, 'settings.json', `touch '${marker}'`);
    expect(await run(input(), { signal: AbortSignal.abort() })).toBe('Opus · ctx 8%\n');
    expect(await exists(marker)).toBe(false);
  }, 20_000);
});

describe('isOwnCommand: наша ли это команда — по полному пути скрипта, а не по имени', () => {
  const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

  it('полная команда харнесса и любая команда с полным путём нашего скрипта — наши', () => {
    expect(isOwnCommand(statusLineCommand())).toBe(true);
    expect(isOwnCommand(`/opt/node/bin/node ${STATUSLINE_ENTRY}`)).toBe(true);
    expect(isOwnCommand(`node ${quote(STATUSLINE_ENTRY)} --x`)).toBe(true);
    expect(isOwnCommand(STATUSLINE_ENTRY)).toBe(true);
  });

  it('то же имя файла в другом месте, обрывок имени и пустая команда — не наши', () => {
    for (const command of [
      `node /home/me/${STATUSLINE_BIN}.js`,
      `/home/me/bin/${STATUSLINE_BIN}`,
      `printf '${STATUSLINE_BIN}'`,
      `cat ${STATUSLINE_BIN}-notes.txt`,
      path.dirname(STATUSLINE_ENTRY),
      '',
    ]) {
      expect(isOwnCommand(command)).toBe(false);
    }
  });
});

/** Настоящий процесс скрипта: код выхода и stdout, как их видит Claude Code. */
function startScript(
  stdin: string,
  extraEnv: NodeJS.ProcessEnv,
): {
  child: ChildProcess;
  result: Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string }>;
} {
  const child = spawn(process.execPath, ['--import', tsxLoader, binScript], {
    env: { ...env, ...extraEnv },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const result = new Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string }>(
    (resolve, reject) => {
      let out = '';
      child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
      child.on('error', reject);
      child.on('close', (code, signal) => resolve({ code, signal, out }));
    },
  );
  child.stdin?.end(stdin);
  return { child, result };
}

const spawnScript = (
  stdin: string,
  extraEnv: NodeJS.ProcessEnv,
): Promise<{ code: number | null; out: string }> => startScript(stdin, extraEnv).result;

describe('процесс скрипта', () => {
  it('битый stdin: код выхода 0 и непустая строка', async () => {
    const result = await spawnScript('не json', { HOME: home });

    expect(result.code).toBe(0);
    expect(result.out).toBe('Claude\n');
  }, 30_000);

  it('вход Claude Code: код 0, строка печатается, файл лимитов пишется', async () => {
    await putStatusLine(home, 'settings.json', "printf 'человек'");

    const result = await spawnScript(input(), { HOME: home });

    expect(result.code).toBe(0);
    expect(result.out).toBe('человек');
    expect(await exists(path.join(workDir, limitsFile))).toBe(true);
  }, 30_000);

  it('составная команда зависла: по настоящему таймауту — короткая строка, код 0, процессов группы не осталось', async () => {
    const pidFile = path.join(root, 'sleeper.pid');
    await putStatusLine(home, 'settings.json', compound(pidFile));

    const { child, result } = startScript(input(), { HOME: home });
    let pid = 0;
    try {
      pid = await sleeperPid(pidFile);
      const done = await result;

      expect(done).toEqual({ code: 0, signal: null, out: 'Opus · ctx 8%\n' });
      await until(() => !alive(pid), 'процесс команды человека убит вместе с группой', 3000);
    } finally {
      if (pid > 0 && alive(pid)) process.kill(pid, 'SIGKILL');
      child.kill('SIGKILL');
    }
  }, 30_000);

  // Claude Code отменяет идущий вызов, когда его вытесняет новый (документация statusline): скрипт
  // получает сигнал. Команда человека живёт в своей группе процессов и сама сигнала не получит.
  it.each(['SIGTERM', 'SIGINT'] as const)(
    '%s посреди команды человека: группа убита, код выхода 0',
    async (name) => {
      const pidFile = path.join(root, 'sleeper.pid');
      await putStatusLine(home, 'settings.json', compound(pidFile));

      const { child, result } = startScript(input(), { HOME: home });
      let pid = 0;
      try {
        pid = await sleeperPid(pidFile);
        child.kill(name);
        const done = await result;

        expect({ code: done.code, signal: done.signal }).toEqual({ code: 0, signal: null });
        await until(() => !alive(pid), 'процесс команды человека убит вместе с группой', 3000);
      } finally {
        if (pid > 0 && alive(pid)) process.kill(pid, 'SIGKILL');
        child.kill('SIGKILL');
      }
    },
    30_000,
  );
});
