/**
 * Скрипт строки статуса Claude Code (спека комнат Organic, 3.5): кладёт `rate_limits` и
 * заполненность контекста в файлы работы и печатает короткую строку терминала. Вход — JSON со
 * stdin по документации code.claude.com/docs/en/statusline; настоящие `claude` и `codex` не
 * запускаются, а «команда человека» в настройках здесь — обычные `touch` и `printf`.
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
  root = await mkdtemp(path.join(tmpdir(), 'parley-statusline-'));
  home = path.join(root, 'home');
  project = path.join(root, 'project');
  workDir = path.join(root, 'work');
  await Promise.all([home, project, workDir].map((dir) => mkdir(dir)));
  // Окружение процесса агента: адрес работы и сессии, как у хуков; HOME — дом человека с его настройками.
  env = {
    PATH: process.env['PATH'],
    HOME: home,
    PARLEY_WORK_DIR: workDir,
    PARLEY_SESSION_ID: 's-01',
  };
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
  (await runStatusline(raw, { env, now: () => NOW, ...options })).toString('utf8');

const limitsFile = path.join('limits', 's-01.json');
const contextRel = path.join('context', 's-01.json');
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

  it('старые сессии (R3): адрес из HARNAS_* тоже читается; оба набора — главнее PARLEY_*', async () => {
    const legacy = { PATH: env['PATH'], HARNAS_WORK_DIR: workDir, HARNAS_SESSION_ID: 's-01' };
    await run(input(), { env: legacy });
    expect(JSON.parse(await readFile(path.join(workDir, limitsFile), 'utf8'))).toEqual({
      at: '2026-09-29T12:00:00.000Z',
      rateLimits,
    });

    const other = path.join(root, 'other-work');
    await mkdir(other);
    await run(input(), { env: { ...legacy, PARLEY_WORK_DIR: other, PARLEY_SESSION_ID: 's-02' } });
    expect(await exists(path.join(other, 'limits', 's-02.json'))).toBe(true);
    expect(await readdir(path.join(workDir, 'limits'))).toEqual(['s-01.json']);
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
      { PARLEY_SESSION_ID: '../evil' },
      { PARLEY_SESSION_ID: '' },
      { PARLEY_WORK_DIR: 'work' },
      { PARLEY_WORK_DIR: undefined },
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

describe('заполненность контекста (спека 2026-10-15, 4.1)', () => {
  it('context_window во входе → context/<сессия>.json', async () => {
    await run(
      input({
        context_window: {
          used_percentage: 41.5,
          context_window_size: 200_000,
          current_usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 83_000 },
        },
      }),
    );
    expect(JSON.parse(await readFile(path.join(workDir, contextRel), 'utf8'))).toEqual({
      usedPercent: 41.5,
      windowTokens: 200_000,
      usedTokens: 83_030,
      at: '2026-09-29T12:00:00.000Z',
    });
  });

  it('без rate_limits контекст всё равно пишется', async () => {
    await run(input({ rate_limits: undefined }));
    expect(JSON.parse(await readFile(path.join(workDir, contextRel), 'utf8'))).toMatchObject({ usedPercent: 8.4 });
  });

  it('нет context_window — файла нет, строка терминала та же', async () => {
    const line = await run(input({ context_window: undefined }));
    await expect(readFile(path.join(workDir, contextRel), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(line).toBe('Opus\n');
  });

  it('id сессии вне isFileSafeId — файла нет', async () => {
    env = { ...env, PARLEY_SESSION_ID: '../s-01' };
    await run(input());
    await expect(readFile(path.join(workDir, contextRel), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
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

  it('statusLine человека в настройках пользователя и проекта не запускается: метки нет, строка короткая', async () => {
    const marker = path.join(root, 'marker');
    const command = `touch '${marker}'; printf 'человек'`;
    await putStatusLine(home, 'settings.json', command);
    await putStatusLine(project, 'settings.json', command);
    await putStatusLine(project, 'settings.local.json', command);

    expect(await run(input())).toBe('Opus · ctx 8%\n');
    expect(await exists(marker)).toBe(false);
    // Данные окна при этом пишутся: файлы лимитов и контекста — как без настроек человека.
    expect(await exists(path.join(workDir, limitsFile))).toBe(true);
    expect(await exists(path.join(workDir, contextRel))).toBe(true);
  });
});

/** Настоящий процесс скрипта: код выхода и stdout, как их видит Claude Code. */
function spawnScript(
  stdin: string,
  extraEnv: NodeJS.ProcessEnv,
): Promise<{ code: number | null; out: string }> {
  const child = spawn(process.execPath, ['--import', tsxLoader, binScript], {
    env: { ...env, ...extraEnv },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const result = new Promise<{ code: number | null; out: string }>((resolve, reject) => {
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out }));
  });
  child.stdin?.end(stdin);
  return result;
}

describe('процесс скрипта', () => {
  it('битый stdin: код выхода 0 и непустая строка', async () => {
    const result = await spawnScript('не json', { HOME: home });

    expect(result.code).toBe(0);
    expect(result.out).toBe('Claude\n');
  }, 30_000);

  it('вход Claude Code: код 0, короткая строка, файлы пишутся, statusLine человека не запускается', async () => {
    const marker = path.join(root, 'marker');
    await putStatusLine(home, 'settings.json', `touch '${marker}'; printf 'человек'`);

    const result = await spawnScript(input(), { HOME: home });

    expect(result.code).toBe(0);
    expect(result.out).toBe('Opus · ctx 8%\n');
    expect(await exists(marker)).toBe(false);
    expect(await exists(path.join(workDir, limitsFile))).toBe(true);
    expect(await exists(path.join(workDir, contextRel))).toBe(true);
  }, 30_000);
});
