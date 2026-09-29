/**
 * Скрипт строки статуса Claude Code (спека комнат Organic, 3.5): кладёт `rate_limits` в файл
 * работы и печатает строку терминала. Вход — JSON со stdin по документации
 * code.claude.com/docs/en/statusline; настоящие `claude` и `codex` не запускаются, а
 * «команда человека» здесь — обычные `printf`, `cat` и `sleep`.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STATUSLINE_BIN, runStatusline } from './statusline.js';

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
  root = await mkdtemp(path.join(tmpdir(), 'harnas-statusline-'));
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

  it('проект — по project_dir (куда запущен Claude Code), даже если агент ушёл в подкаталог', async () => {
    const inner = path.join(project, 'src');
    await mkdir(inner);
    await putStatusLine(project, 'settings.json', "printf 'проектная'");

    expect(await run(input({ workspace: { current_dir: inner, project_dir: project } }))).toBe(
      'проектная',
    );
    // Старый Claude Code без project_dir: берётся current_dir.
    expect(await run(input({ workspace: { current_dir: project } }))).toBe('проектная');
    // Ни того ни другого во входе — каталог самого процесса: Claude Code зовёт скрипт из своего cwd.
    expect(await run(input({ workspace: undefined }), { cwd: project })).toBe('проектная');
  });

  it('наш же скрипт в настройках человека не зовётся: короткая строка вместо рекурсии', async () => {
    const marker = path.join(root, 'called');
    // Команда с именем нашего скрипта, оставляющая след, если её всё-таки вызвали.
    await putStatusLine(
      home,
      'settings.json',
      `touch '${marker}'; echo /x/work/${STATUSLINE_BIN}.js`,
    );

    expect(await run(input())).toBe('Opus · ctx 8%\n');
    expect(await exists(marker)).toBe(false);
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
});

/** Настоящий процесс скрипта: код выхода и stdout, как их видит Claude Code. */
function spawnScript(
  stdin: string,
  extraEnv: NodeJS.ProcessEnv,
): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', tsxLoader, binScript], {
      env: { ...env, ...extraEnv },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out }));
    child.stdin.end(stdin);
  });
}

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
});
