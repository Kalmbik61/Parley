/**
 * Каталог моделей Qwen Code (спека 2026-11-12, 8.4, задача Q2). Настоящий `qwen` здесь не запускается никогда: проба
 * идёт на выдуманную команду, чья переменная-оверрайд (`PARLEY_<ИМЯ>_BIN`) указывает на скрипт-заглушку `qwen --acp`
 * во временном каталоге. Форма ответа заглушки — выдуманная копия формы из спеки (8.3, п. 2).
 */
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { qwenModelsFile } from '@parley/core';
import type { RequestInfo } from '../methods/context.js';
import { createProvidersList } from '../methods/providers.js';
import type { Log } from '../log.js';

/** Запись путей, которые код Parley открывает через `node:fs/promises`, пока `recording` включён. */
const spy = vi.hoisted(() => ({ recording: false, paths: [] as string[] }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const wrap = <K extends keyof typeof actual>(name: K): (typeof actual)[K] =>
    ((...args: unknown[]) => {
      if (spy.recording && typeof args[0] === 'string') spy.paths.push(args[0]);
      return (actual[name] as (...a: unknown[]) => unknown)(...args);
    }) as (typeof actual)[K];
  const wrapped = {
    ...actual,
    readFile: wrap('readFile'),
    writeFile: wrap('writeFile'),
    mkdir: wrap('mkdir'),
    mkdtemp: wrap('mkdtemp'),
    rename: wrap('rename'),
    rm: wrap('rm'),
    open: wrap('open'),
    readdir: wrap('readdir'),
    stat: wrap('stat'),
    lstat: wrap('lstat'),
    copyFile: wrap('copyFile'),
    appendFile: wrap('appendFile'),
  };
  return { ...wrapped, default: wrapped };
});

const { parseQwenModels, probeQwenModels, startQwenCatalog, QWEN_CATALOG_MAX_AGE_MS } = await import('./qwen-catalog.js');

const COMMAND = 'parley-fake-qwen';
const OVERRIDE = 'PARLEY_PARLEY_FAKE_QWEN_BIN';

/** Выдуманные модели той же формы, что отдаёт `session/new` (спека 8.3, п. 2): два аккаунтных и одна runtime. */
const AVAILABLE = [
  { modelId: 'qwen-demo-preview(demo-account)', name: 'qwen-demo-preview', description: null, _meta: { contextLimit: 1000000, authType: 'demo-account', baseModelId: 'qwen-demo-preview', isRuntime: false } },
  { modelId: 'qwen-demo-max(demo-account)', name: 'qwen-demo-max', description: null, _meta: { contextLimit: 1000000, authType: 'demo-account', baseModelId: 'qwen-demo-max', isRuntime: false } },
  { modelId: '$runtime|openai|rt-model(openai)', name: 'rt-model', description: null, _meta: { contextLimit: 8000, authType: 'openai', baseModelId: 'rt-model', isRuntime: true } },
  { modelId: 'qwen-demo-flash(demo-account)', name: 'qwen-demo-flash', description: null, _meta: { contextLimit: 1000000, authType: 'demo-account', baseModelId: 'qwen-demo-flash', isRuntime: false } },
];

/** Скрипт-заглушка `qwen --acp`: режим из `FAKE_MODE`, журнал запусков в `FAKE_LOG`, pid в `FAKE_PIDS`. */
const FAKE = `#!/usr/bin/env node
import fs from 'node:fs';
import cp from 'node:child_process';
import readline from 'node:readline';
const mode = process.env.FAKE_MODE ?? 'ok';
const available = JSON.parse(process.env.FAKE_MODELS ?? '[]');
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: Object.keys(process.env).sort(), pid: process.pid }) + '\\n');
if (mode === 'fork' || mode === 'fork-stubborn') {
  const body = (mode === 'fork-stubborn' ? "process.on('SIGTERM', () => {});" : '') + 'setInterval(() => {}, 1000);';
  const child = cp.spawn(process.execPath, ['-e', body], { stdio: ['ignore', 'inherit', 'inherit'] });
  fs.writeFileSync(process.env.FAKE_PIDS, JSON.stringify({ leader: process.pid, child: child.pid }));
  if (mode === 'fork-stubborn') process.on('SIGTERM', () => {});
}
const write = (value) => process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === 1) return write({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1, agentInfo: { name: 'qwen-code', version: '0.0.0-fake' } } });
  if (message.id !== 2 || mode === 'hang' || mode === 'fork' || mode === 'fork-stubborn') return;
  if (mode === 'auth') return write({ jsonrpc: '2.0', id: 2, error: { code: -32000, message: 'Authentication required: Use /auth to sign in or configure a model first.' } });
  if (mode === 'malformed') return write('this is not json\\n');
  if (mode === 'oversize') return write('x'.repeat(2 * 1024 * 1024));
  const reply = () => write({ jsonrpc: '2.0', id: 2, result: { sessionId: 'fake', models: { currentModelId: 'x', availableModels: available } } });
  if (mode === 'slow') setTimeout(reply, 300); else reply();
});
setInterval(() => {}, 1000);
`;

let dir = '';
let home = '';
let tmpRoot = '';
const saved: Record<string, string | undefined> = {};

const quiet = (): Log => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) as unknown as Log;

const probeEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  PATH: process.env['PATH'] ?? '',
  HOME: home,
  [OVERRIDE]: path.join(dir, 'fake-qwen.mjs'),
  FAKE_MODELS: JSON.stringify(AVAILABLE),
  FAKE_LOG: path.join(dir, 'runs.jsonl'),
  FAKE_PIDS: path.join(dir, 'pids.json'),
  ...extra,
});

const runs = async (): Promise<Array<{ argv: string[]; cwd: string; env: string[]; pid: number }>> => {
  try {
    return (await readFile(path.join(dir, 'runs.jsonl'), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'qwen-catalog-'));
  home = path.join(dir, 'home');
  tmpRoot = path.join(dir, 'tmp');
  await import('node:fs/promises').then(({ mkdir }) => Promise.all([mkdir(home), mkdir(tmpRoot)]));
  const script = path.join(dir, 'fake-qwen.mjs');
  await writeFile(script, FAKE, 'utf8');
  await chmod(script, 0o755);
  for (const name of ['PARLEY_HOME']) {
    saved[name] = process.env[name];
    process.env[name] = home;
  }
  spy.recording = false;
  spy.paths.length = 0;
});

afterEach(async () => {
  spy.recording = false;
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

const probe = (extra: Record<string, string> = {}, options: Parameters<typeof probeQwenModels>[1] = {}) =>
  probeQwenModels(COMMAND, { env: probeEnv(extra), tmpRoot, timeoutMs: 4000, ...options });

describe('parseQwenModels', () => {
  it('keeps account models in ACP order with bare ids, drops runtime entries, efforts null', () => {
    expect(parseQwenModels(AVAILABLE)).toEqual([
      { id: 'qwen-demo-preview', label: 'qwen-demo-preview', efforts: null },
      { id: 'qwen-demo-max', label: 'qwen-demo-max', efforts: null },
      { id: 'qwen-demo-flash', label: 'qwen-demo-flash', efforts: null },
    ]);
  });

  it.each([
    ['not an array', { models: [] }],
    ['an empty list', []],
    ['only runtime entries', [AVAILABLE[2]]],
    ['entries of the wrong shape', [null, 'x', { name: 'a' }, { name: 'a', _meta: { isRuntime: false } }, { name: 'a', _meta: { isRuntime: false, baseModelId: '-flag' } }]],
  ])('%s gives null', (_title, value) => {
    expect(parseQwenModels(value)).toBeNull();
  });

  it('drops duplicates and ids that would not be one word', () => {
    const entry = (id: string) => ({ name: id, _meta: { isRuntime: false, baseModelId: id } });
    expect(parseQwenModels([entry('a'), entry('a'), entry('b c'), entry('d')])?.map((model) => model.id)).toEqual(['a', 'd']);
  });
});

describe('probeQwenModels with a fake qwen --acp', () => {
  it('answers with availableModels; the process, its pipes and the temp cwd are gone', async () => {
    const result = await probe();
    expect(parseQwenModels(result)?.map((model) => model.id)).toEqual(['qwen-demo-preview', 'qwen-demo-max', 'qwen-demo-flash']);
    const [run] = await runs();
    expect(run?.argv).toEqual(['--acp']);
    expect(run?.cwd.startsWith(await import('node:fs/promises').then(({ realpath }) => realpath(tmpRoot)))).toBe(true);
    expect(alive(run!.pid)).toBe(false);
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it.each([
    ['an authentication error', 'auth'],
    ['malformed JSON', 'malformed'],
    ['output over the cap', 'oversize'],
  ])('%s gives null and leaves no process or temp dir', async (_title, mode) => {
    expect(await probe({ FAKE_MODE: mode })).toBeNull();
    const [run] = await runs();
    expect(alive(run!.pid)).toBe(false);
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it('a hang gives null at the timeout and cleans up', async () => {
    const started = Date.now();
    expect(await probe({ FAKE_MODE: 'hang' }, { timeoutMs: 300 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(300 + 2000);
    expect(alive((await runs())[0]!.pid)).toBe(false);
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it('no binary: null, and no temp dir is left', async () => {
    expect(await probeQwenModels(COMMAND, { env: { PATH: process.env['PATH'] ?? '', [OVERRIDE]: path.join(dir, 'missing') }, tmpRoot })).toBeNull();
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it('cleanup: a child holding stdout open ends the probe within timeout + 2 s; no group member is left', async () => {
    const started = Date.now();
    expect(await probe({ FAKE_MODE: 'fork' }, { timeoutMs: 400 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(400 + 2000 + 500);
    const pids = JSON.parse(await readFile(path.join(dir, 'pids.json'), 'utf8')) as { leader: number; child: number };
    await vi.waitFor(() => expect([alive(pids.leader), alive(pids.child)]).toEqual([false, false]), { timeout: 1000 });
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it('cleanup: members that ignore SIGTERM are killed after the grace', async () => {
    const started = Date.now();
    expect(await probe({ FAKE_MODE: 'fork-stubborn' }, { timeoutMs: 300, killGraceMs: 300 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(300 + 300 + 1000 + 500);
    const pids = JSON.parse(await readFile(path.join(dir, 'pids.json'), 'utf8')) as { leader: number; child: number };
    await vi.waitFor(() => expect([alive(pids.leader), alive(pids.child)]).toEqual([false, false]), { timeout: 1500 });
    expect(await readdir(tmpRoot)).toEqual([]);
  });
});

describe('secret boundary', () => {
  it('spawns `--acp` only, in a temp cwd, with exactly the environment given: no credential path, key or Parley settings file added', async () => {
    const env = probeEnv();
    await probeQwenModels(COMMAND, { env, tmpRoot, timeoutMs: 4000 });
    const [run] = await runs();
    expect(run?.argv).toEqual(['--acp']);
    const given = new Set(Object.keys(env));
    // macOS adds __CF_USER_TEXT_ENCODING to every child process itself; Parley adds nothing.
    expect(run?.env.filter((key) => !given.has(key) && key !== '__CF_USER_TEXT_ENCODING')).toEqual([]);
    for (const key of run?.env ?? []) expect(key).not.toMatch(/^(QWEN_CODE_SYSTEM_SETTINGS_PATH|QWEN_HOME|OPENAI_)/);
    expect(JSON.stringify(run)).not.toMatch(/oauth|credential|\.qwen|settings/i);
  });

  it('opens no file but its temp cwd and qwen-models.json (probe and catalog end to end)', async () => {
    const onChange = vi.fn();
    spy.paths.length = 0;
    spy.recording = true;
    const catalog = startQwenCatalog(() => probeQwenModels(COMMAND, { env: probeEnv(), tmpRoot, timeoutMs: 4000 }), quiet(), onChange);
    await catalog.ready;
    spy.recording = false;

    expect(onChange).toHaveBeenCalledTimes(1);
    const real = await import('node:fs/promises').then(({ realpath }) => realpath(tmpRoot));
    const file = qwenModelsFile();
    expect(spy.paths.length).toBeGreaterThan(0);
    for (const opened of spy.paths) {
      const inProbeCwd = opened.startsWith(path.join(tmpRoot, 'parley-qwen-probe-')) || opened.startsWith(path.join(real, 'parley-qwen-probe-'));
      const inCatalog = opened === file || opened.startsWith(`${file}.`) || opened === path.dirname(file);
      expect({ opened, allowed: inProbeCwd || inCatalog }).toEqual({ opened, allowed: true });
    }
    expect(spy.paths.join('\n')).not.toMatch(/oauth|credential|\.qwen|settings\.json|subscription/i);
  });
});

describe('startQwenCatalog', () => {
  const stub = (result: unknown = AVAILABLE) => vi.fn(async () => result);

  it('first success writes qwen-models.json and fires onChange once; the same list again changes nothing', async () => {
    const onChange = vi.fn();
    const catalog = startQwenCatalog(stub(), quiet(), onChange);
    await catalog.ready;
    expect(onChange).toHaveBeenCalledTimes(1);
    const stored = JSON.parse(await readFile(qwenModelsFile(), 'utf8')) as { fetchedAt: string; models: Array<{ id: string }> };
    expect(stored.models.map((model) => model.id)).toEqual(['qwen-demo-preview', 'qwen-demo-max', 'qwen-demo-flash']);
    expect(catalog.current()?.map((model) => model.id)).toEqual(['qwen-demo-preview', 'qwen-demo-max', 'qwen-demo-flash']);
    const before = await readFile(qwenModelsFile(), 'utf8');
    await catalog.refresh();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(await readFile(qwenModelsFile(), 'utf8')).toBe(before);
  });

  it('a changed list rewrites the file and fires onChange again', async () => {
    let result: unknown = AVAILABLE;
    const onChange = vi.fn();
    const catalog = startQwenCatalog(async () => result, quiet(), onChange);
    await catalog.ready;
    result = AVAILABLE.slice(0, 2);
    await catalog.refresh();
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await readFile(qwenModelsFile(), 'utf8')).models).toHaveLength(2);
  });

  it.each([
    ['a failed probe (null)', () => null],
    ['a thrown probe', () => { throw new Error('boom'); }],
    ['a shape that is not a model list', () => ({ models: [] })],
    ['only runtime entries', () => [AVAILABLE[2]]],
  ])('%s leaves the stored file untouched and fires nothing', async (_title, result) => {
    await writeFile(qwenModelsFile(), '{"fetchedAt":"2030-01-01T00:00:00.000Z","models":[{"id":"old","label":"old","efforts":null}]}\n', 'utf8');
    const before = await readFile(qwenModelsFile(), 'utf8');
    const onChange = vi.fn();
    const catalog = startQwenCatalog(async () => result(), quiet(), onChange);
    await catalog.ready;
    expect(onChange).not.toHaveBeenCalled();
    expect(await readFile(qwenModelsFile(), 'utf8')).toBe(before);
    expect(catalog.current()).toBeNull();
  });

  it('real failures of the fake CLI (auth, malformed, oversize, timeout) keep the stored file', async () => {
    await writeFile(qwenModelsFile(), '{"fetchedAt":"2030-01-01T00:00:00.000Z","models":[{"id":"old","label":"old","efforts":null}]}\n', 'utf8');
    const before = await readFile(qwenModelsFile(), 'utf8');
    for (const mode of ['auth', 'malformed', 'oversize', 'hang']) {
      const catalog = startQwenCatalog(() => probeQwenModels(COMMAND, { env: probeEnv({ FAKE_MODE: mode }), tmpRoot, timeoutMs: mode === 'hang' ? 300 : 4000 }), quiet(), vi.fn());
      await catalog.ready;
      expect(await readFile(qwenModelsFile(), 'utf8')).toBe(before);
    }
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it('without a probe nothing runs and no file is written', async () => {
    const catalog = startQwenCatalog(undefined, quiet(), vi.fn());
    await catalog.ready;
    await catalog.refresh();
    catalog.refreshIfStale();
    await expect(readFile(qwenModelsFile(), 'utf8')).rejects.toThrow();
  });

  it('three concurrent triggers share one probe', async () => {
    let release: (value: unknown) => void = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    const probeFn = vi.fn(() => gate);
    const catalog = startQwenCatalog(probeFn, quiet(), vi.fn());
    const all = Promise.all([catalog.refresh(), catalog.refresh(), catalog.ready]);
    catalog.refreshIfStale();
    expect(probeFn).toHaveBeenCalledTimes(1);
    release(AVAILABLE);
    await all;
    expect(probeFn).toHaveBeenCalledTimes(1);
  });

  it('three concurrent triggers spawn one qwen process', async () => {
    const catalog = startQwenCatalog(() => probeQwenModels(COMMAND, { env: probeEnv({ FAKE_MODE: 'slow' }), tmpRoot, timeoutMs: 4000 }), quiet(), vi.fn());
    await Promise.all([catalog.refresh(), catalog.refresh(), catalog.ready]);
    expect(await runs()).toHaveLength(1);
  });

  it('providers.list answers at once during a probe: no stored list means qwen models are null; the stored list once there is one', async () => {
    let release: (value: unknown) => void = () => {};
    const catalog = startQwenCatalog(() => new Promise((resolve) => { release = resolve; }), quiet(), vi.fn());
    const list = createProvidersList(undefined, undefined, undefined, undefined, undefined, undefined, undefined, catalog);
    const qwenModels = async () => {
      const { providers } = await list({}, {} as RequestInfo);
      return providers.find((entry) => entry.id === 'qwen')?.models;
    };
    const started = Date.now();
    expect(await qwenModels()).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);

    release(AVAILABLE);
    await catalog.ready;
    expect((await qwenModels())?.map((model) => model.id)).toEqual(['qwen-demo-preview', 'qwen-demo-max', 'qwen-demo-flash']);
  });

  it('refreshIfStale: no new probe before 6 h, one after; sign-in (refresh) probes at once', async () => {
    let at = 1_000_000;
    const probeFn = stub();
    const catalog = startQwenCatalog(probeFn, quiet(), vi.fn(), { now: () => at });
    await catalog.ready;
    expect(probeFn).toHaveBeenCalledTimes(1);

    at += QWEN_CATALOG_MAX_AGE_MS - 1;
    catalog.refreshIfStale();
    await catalog.refresh().catch(() => {});
    // refresh() is an explicit trigger (sign-in): it ran a second probe; the stale check alone did not.
    expect(probeFn).toHaveBeenCalledTimes(2);

    const before = probeFn.mock.calls.length;
    at += QWEN_CATALOG_MAX_AGE_MS - 1;
    catalog.refreshIfStale();
    expect(probeFn.mock.calls.length).toBe(before);
    at += 2;
    catalog.refreshIfStale();
    expect(probeFn.mock.calls.length).toBe(before + 1);
    catalog.refreshIfStale();
    expect(probeFn.mock.calls.length).toBe(before + 1);
  });
});
