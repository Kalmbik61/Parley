/**
 * Скрипт `notify` Codex (спека комнат Organic, 3.6): Codex зовёт его после хода, JSON события —
 * последним аргументом, а он дописывает строку `Stop` в журнал событий сессии, как команда
 * хуков Claude Code. Настоящий `codex` не запускается: JSON здесь — то, что описывает
 * документация (`agent-turn-complete`), а Codex заменяет обычный `spawn` с нужным argv.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CODEX_NOTIFY_BIN,
  CODEX_NOTIFY_ENTRY,
  NOTIFY_MESSAGE_MAX,
  runCodexNotify,
  stopEventOf,
} from './codex-notify.js';
import { openEvents } from './events.js';
import { activityOf } from './activity.js';

const require = createRequire(import.meta.url);
const tsxLoader = pathToFileURL(require.resolve('tsx')).href;
const binScript = fileURLToPath(new URL(`./${CODEX_NOTIFY_BIN}.ts`, import.meta.url));

/** Событие Codex `agent-turn-complete` в том виде, как его описывает документация `notify`. */
const turnComplete = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: 'agent-turn-complete',
    'thread-id': '019ce3d5-584a-7be2-922e-b8185a8d7c19',
    'turn-id': 'turn-7',
    cwd: '/Users/dev/проект',
    client: 'codex-tui',
    'input-messages': ['почини сборку'],
    'last-assistant-message': 'Готово: сборка починена.',
    ...over,
  });

let root = '';
let workDir = '';
let env: NodeJS.ProcessEnv = {};

const journal = (): string => path.join(workDir, 'events', 's-03.jsonl');
const lines = async (): Promise<Array<Record<string, unknown>>> =>
  (await readFile(journal(), 'utf8'))
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'parley-codex-notify-'));
  workDir = path.join(root, '.parley', 'works', 'w-0001');
  await mkdir(workDir, { recursive: true });
  // Окружение процесса Codex, а значит и notify: адрес работы и сессии, как у команды хуков.
  env = { PARLEY_WORK_DIR: workDir, PARLEY_SESSION_ID: 's-03' };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('stopEventOf', () => {
  it('agent-turn-complete → строка Stop с последним ответом и id треда', () => {
    expect(stopEventOf(turnComplete())).toEqual({
      hook_event_name: 'Stop',
      last_assistant_message: 'Готово: сборка починена.',
      'thread-id': '019ce3d5-584a-7be2-922e-b8185a8d7c19',
      'turn-id': 'turn-7',
    });
  });

  it('ответа нет (`null`) — поле остаётся `null`, событие всё равно Stop', () => {
    const event = stopEventOf(turnComplete({ 'last-assistant-message': null }));
    expect(event).toMatchObject({ hook_event_name: 'Stop', last_assistant_message: null });
  });

  it('нет id треда и хода — строка Stop без них', () => {
    const event = stopEventOf(JSON.stringify({ type: 'agent-turn-complete' }));
    expect(event).toEqual({ hook_event_name: 'Stop', last_assistant_message: null });
  });

  it('длинный ответ урезается, парный суррогат по границе не рвётся', () => {
    const long = `${'а'.repeat(NOTIFY_MESSAGE_MAX - 1)}😀хвост`;
    const message = stopEventOf(turnComplete({ 'last-assistant-message': long }))?.[
      'last_assistant_message'
    ] as string;
    expect(message.length).toBeLessThanOrEqual(NOTIFY_MESSAGE_MAX);
    expect(message.startsWith('а'.repeat(NOTIFY_MESSAGE_MAX - 1))).toBe(true);
    // Половинка эмодзи на конце превратила бы журнал в невалидный UTF-8 при следующей записи.
    expect(message).not.toMatch(/[\ud800-\udbff]$/);
  });

  it('другое событие, битый JSON и не объект — ничего', () => {
    expect(stopEventOf(turnComplete({ type: 'approval-requested' }))).toBeNull();
    expect(stopEventOf(JSON.stringify({ 'last-assistant-message': 'нет type' }))).toBeNull();
    expect(stopEventOf('не json')).toBeNull();
    expect(stopEventOf('')).toBeNull();
    expect(stopEventOf('[1,2]')).toBeNull();
    expect(stopEventOf('null')).toBeNull();
  });

  it('id треда и хода не строки — их в событии нет', () => {
    const event = stopEventOf(turnComplete({ 'thread-id': 5, 'turn-id': { x: 1 } }));
    expect(event).not.toHaveProperty('thread-id');
    expect(event).not.toHaveProperty('turn-id');
  });
});

describe('runCodexNotify', () => {
  it('дописывает строку Stop в events/<сессия>.jsonl и заводит каталог events', async () => {
    await expect(stat(path.join(workDir, 'events'))).rejects.toThrow();
    expect(await runCodexNotify(turnComplete(), env)).toBe(true);

    const [event] = await lines();
    expect(event).toMatchObject({
      hook_event_name: 'Stop',
      last_assistant_message: 'Готово: сборка починена.',
      'thread-id': '019ce3d5-584a-7be2-922e-b8185a8d7c19',
    });
  });

  it('второй ход — вторая строка: журнал дописывается, а не перезаписывается', async () => {
    await runCodexNotify(turnComplete({ 'last-assistant-message': 'первый' }), env);
    await runCodexNotify(turnComplete({ 'last-assistant-message': 'второй' }), env);
    expect((await lines()).map((event) => event['last_assistant_message'])).toEqual([
      'первый',
      'второй',
    ]);
  });

  it('читатель журнала core видит в строке обычное событие Stop — конец хода', async () => {
    await runCodexNotify(turnComplete(), env);
    const events = await openEvents(path.join(workDir, 'events')).read('s-03');
    expect(events?.map((event) => event.name)).toEqual(['Stop']);
    expect(activityOf({ events }).activity).toBe('unseen');
  });

  it('старые сессии (R3): адрес из HARNAS_* тоже читается; оба набора — главнее PARLEY_*', async () => {
    expect(await runCodexNotify(turnComplete(), { HARNAS_WORK_DIR: workDir, HARNAS_SESSION_ID: 's-03' })).toBe(true);
    expect((await lines()).map((line) => line['hook_event_name'])).toEqual(['Stop']);

    const other = path.join(root, 'other');
    await mkdir(other);
    const both = { HARNAS_WORK_DIR: workDir, HARNAS_SESSION_ID: 's-03', PARLEY_WORK_DIR: other, PARLEY_SESSION_ID: 's-09' };
    expect(await runCodexNotify(turnComplete(), both)).toBe(true);
    expect((await readFile(path.join(other, 'events', 's-09.jsonl'), 'utf8')).split('\n')[0]).toContain('Stop');
    expect(await lines()).toHaveLength(1);
  });

  it('чужие поля события (input-messages, cwd) в журнал не попадают', async () => {
    await runCodexNotify(turnComplete(), env);
    const [event] = await lines();
    expect(Object.keys(event ?? {}).sort()).toEqual([
      'hook_event_name',
      'last_assistant_message',
      'thread-id',
      'turn-id',
    ]);
  });

  it('каталога работы нет (её удалили под живым агентом) — не воскрешает, не падает', async () => {
    await rm(workDir, { recursive: true });
    expect(await runCodexNotify(turnComplete(), env)).toBe(false);
    await expect(stat(workDir)).rejects.toThrow();
  });

  it('нет адреса в окружении, относительный каталог и небезопасный id — не пишет', async () => {
    expect(await runCodexNotify(turnComplete(), {})).toBe(false);
    expect(await runCodexNotify(turnComplete(), { PARLEY_WORK_DIR: workDir })).toBe(false);
    expect(await runCodexNotify(turnComplete(), { PARLEY_SESSION_ID: 's-03' })).toBe(false);
    expect(
      await runCodexNotify(turnComplete(), { PARLEY_WORK_DIR: 'work', PARLEY_SESSION_ID: 's-03' }),
    ).toBe(false);
    for (const id of ['../s-03', 'a/b', '.скрытый', '', '/etc/passwd']) {
      expect(
        await runCodexNotify(turnComplete(), { PARLEY_WORK_DIR: workDir, PARLEY_SESSION_ID: id }),
      ).toBe(false);
    }
    await expect(stat(path.join(workDir, 'events'))).rejects.toThrow();
  });

  it('не то событие или мусор вместо JSON — журнал не трогается', async () => {
    expect(await runCodexNotify(turnComplete({ type: 'approval-requested' }), env)).toBe(false);
    expect(await runCodexNotify('мусор', env)).toBe(false);
    await expect(stat(path.join(workDir, 'events'))).rejects.toThrow();
  });

  it('журнал не записывается (events — файл, а не каталог): ошибка не летит наружу', async () => {
    await writeFile(path.join(workDir, 'events'), 'занято');
    expect(await runCodexNotify(turnComplete(), env)).toBe(false);
  });
});

describe('точка входа', () => {
  const spawnScript = (
    args: string[],
    extraEnv: NodeJS.ProcessEnv,
  ): Promise<{ code: number | null; out: string }> =>
    new Promise((resolve, reject) => {
      // Как Codex: прямой запуск без оболочки, JSON последним аргументом, stdin закрыт.
      const child = spawn(process.execPath, ['--import', tsxLoader, binScript, ...args], {
        env: { PATH: process.env['PATH'], ...extraEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
      child.stderr?.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, out }));
    });

  it('путь скрипта — рядом с модулем, в work/, собранным .js', () => {
    expect(path.isAbsolute(CODEX_NOTIFY_ENTRY)).toBe(true);
    expect(path.basename(CODEX_NOTIFY_ENTRY)).toBe('codex-notify-bin.js');
  });

  it('JSON — последний аргумент: строка Stop в журнале, код выхода 0, вывода нет', async () => {
    const result = await spawnScript(['--ignored', turnComplete()], env);
    expect(result).toEqual({ code: 0, out: '' });
    expect((await lines()).map((event) => event['hook_event_name'])).toEqual(['Stop']);
  });

  it('без аргументов, с мусором и без адреса — код 0 и тишина: Codex не должен страдать', async () => {
    expect(await spawnScript([], env)).toEqual({ code: 0, out: '' });
    expect(await spawnScript(['мусор'], env)).toEqual({ code: 0, out: '' });
    expect(await spawnScript([turnComplete()], {})).toEqual({ code: 0, out: '' });
    await expect(stat(journal())).rejects.toThrow();
  });
});
