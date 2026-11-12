/**
 * OpenCode model catalog (spec 2026-11-12 §4.7, task O11 part 1). The real `opencode` never runs here: the probe runs an
 * invented command whose override variable (`PARLEY_<NAME>_BIN`) points to a stub script in a temporary directory.
 */
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Log } from '../log.js';
import {
  OPENCODE_CATALOG_MAX_AGE_MS,
  parseOpencodeModels,
  probeOpencodeModels,
  startOpencodeCatalog,
} from './opencode-catalog.js';

const COMMAND = 'parley-fake-opencode';
const OVERRIDE = 'PARLEY_PARLEY_FAKE_OPENCODE_BIN';

const OUTPUT = 'demo/alpha-free\ndemo/beta\n\nother/nested/model-1\n';

const FAKE = `#!/usr/bin/env node
import fs from 'node:fs';
import cp from 'node:child_process';
const mode = process.env.FAKE_MODE ?? 'ok';
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), pid: process.pid }) + '\\n');
if (mode === 'fork' || mode === 'fork-stubborn') {
  const body = (mode === 'fork-stubborn' ? "process.on('SIGTERM', () => {});" : '') + 'setInterval(() => {}, 1000);';
  const child = cp.spawn(process.execPath, ['-e', body], { stdio: ['ignore', 'inherit', 'inherit'] });
  fs.writeFileSync(process.env.FAKE_PIDS, JSON.stringify({ leader: process.pid, child: child.pid }));
  if (mode === 'fork-stubborn') process.on('SIGTERM', () => {});
  process.stdout.write('demo/alpha-free\\n');
  setInterval(() => {}, 1000);
} else if (mode === 'hang') {
  setInterval(() => {}, 1000);
} else if (mode === 'fail') {
  process.stderr.write('boom\\n');
  process.exit(1);
} else if (mode === 'oversize') {
  process.stdout.write('x'.repeat(2 * 1024 * 1024));
  setInterval(() => {}, 1000);
} else {
  process.stdout.write(process.env.FAKE_OUTPUT ?? '');
}
`;

let dir = '';
let tmpRoot = '';
const quiet = (): Log => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) as unknown as Log;
const probeEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  PATH: process.env['PATH'] ?? '',
  [OVERRIDE]: path.join(dir, 'fake-opencode.mjs'),
  FAKE_OUTPUT: OUTPUT,
  FAKE_LOG: path.join(dir, 'runs.jsonl'),
  FAKE_PIDS: path.join(dir, 'pids.json'),
  ...extra,
});
const runs = async (): Promise<Array<{ argv: string[]; cwd: string }>> => {
  try {
    return (await readFile(path.join(dir, 'runs.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
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
  dir = await mkdtemp(path.join(tmpdir(), 'opencode-catalog-'));
  tmpRoot = path.join(dir, 'tmp');
  await mkdir(tmpRoot);
  const script = path.join(dir, 'fake-opencode.mjs');
  await writeFile(script, FAKE, 'utf8');
  await chmod(script, 0o755);
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

describe('parseOpencodeModels', () => {
  it('reads provider/model lines in CLI order, with effort off', () => {
    expect(parseOpencodeModels(OUTPUT)).toEqual([
      { id: 'demo/alpha-free', label: 'demo/alpha-free', efforts: null },
      { id: 'demo/beta', label: 'demo/beta', efforts: null },
      { id: 'other/nested/model-1', label: 'other/nested/model-1', efforts: null },
    ]);
  });

  it('drops repeats, variants, spaces and lines of another shape, and warns', () => {
    const log = { warn: vi.fn() };
    expect(parseOpencodeModels('a/b\r\na/b\nplain\na/b#high\n/x\nx/\na b/c\n', log)?.map((m) => m.id)).toEqual(['a/b']);
    expect(log.warn).toHaveBeenCalledTimes(6);
  });

  it.each([[''], ['\n\n'], ['nothing here'], [null], [42]])('gives null for %j', (value) => {
    expect(parseOpencodeModels(value)).toBeNull();
  });
});

describe('probeOpencodeModels', () => {
  it('runs `models` in an empty temporary cwd and removes it', async () => {
    const out = await probeOpencodeModels(COMMAND, { env: probeEnv(), tmpRoot });
    expect(out).toBe(OUTPUT);
    const [run] = await runs();
    expect(run?.argv).toEqual(['models']);
    expect(run?.cwd.startsWith(await (await import('node:fs/promises')).realpath(tmpRoot))).toBe(true);
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it.each([['fail'], ['hang'], ['oversize']])('gives null for mode %s', async (mode) => {
    const out = await probeOpencodeModels(COMMAND, { env: probeEnv({ FAKE_MODE: mode }), tmpRoot, timeoutMs: 600, maxBytes: 1024 * 1024, killGraceMs: 300 });
    expect(out).toBeNull();
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it('gives null for a command that does not exist', async () => {
    expect(await probeOpencodeModels('parley-no-such-opencode', { env: { PATH: '' }, tmpRoot })).toBeNull();
  });

  it.each([['fork'], ['fork-stubborn']])('kills the whole process group (%s)', async (mode) => {
    const out = await probeOpencodeModels(COMMAND, { env: probeEnv({ FAKE_MODE: mode }), tmpRoot, timeoutMs: 700, killGraceMs: 300 });
    expect(out).toBeNull();
    const pids = JSON.parse(await readFile(path.join(dir, 'pids.json'), 'utf8')) as { leader: number; child: number };
    await vi.waitFor(() => {
      expect(alive(pids.leader)).toBe(false);
      expect(alive(pids.child)).toBe(false);
    }, { timeout: 3000 });
  });
});

describe('startOpencodeCatalog', () => {
  const models = (...ids: string[]): string => `${ids.join('\n')}\n`;
  let file = '';
  beforeEach(() => {
    file = path.join(dir, 'home', 'opencode-models.json');
  });
  const stored = async (): Promise<{ fetchedAt: string; models: Array<{ id: string }> }> => JSON.parse(await readFile(file, 'utf8'));

  it('writes the file, calls onChange once and serves current(); the same list later does not rewrite', async () => {
    const probe = vi.fn(async () => models('a/one', 'a/two'));
    const onChange = vi.fn();
    const catalog = startOpencodeCatalog(probe, quiet(), onChange, { file, command: COMMAND });
    await catalog.ready;
    expect(probe).toHaveBeenCalledWith(COMMAND);
    expect((await stored()).models.map((m) => m.id)).toEqual(['a/one', 'a/two']);
    expect(catalog.current()?.map((m) => m.id)).toEqual(['a/one', 'a/two']);
    await catalog.refresh();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('a failed probe keeps the old file and the old list', async () => {
    let answer: string | null = models('a/one');
    const catalog = startOpencodeCatalog(async () => answer, quiet(), vi.fn(), { file });
    await catalog.ready;
    const before = await readFile(file, 'utf8');
    answer = null;
    await catalog.refresh();
    answer = 'garbage without slash';
    await catalog.refresh();
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(catalog.current()?.map((m) => m.id)).toEqual(['a/one']);
  });

  it('a failed write keeps the old file and leaves no temporary file', async () => {
    let answer = models('a/one');
    const catalog = startOpencodeCatalog(async () => answer, quiet(), vi.fn(), { file });
    await catalog.ready;
    const before = await readFile(file, 'utf8');
    await rm(file);
    await mkdir(file); // rename onto a directory fails
    answer = models('a/two');
    await catalog.refresh();
    await rm(file, { recursive: true });
    await writeFile(file, before);
    expect((await readdir(path.dirname(file))).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('shares a running probe: one probe at a time', async () => {
    let release: (v: string) => void = () => {};
    const probe = vi.fn(() => new Promise<string>((resolve) => { release = resolve; }));
    const catalog = startOpencodeCatalog(probe, quiet(), vi.fn(), { file });
    const second = catalog.refresh();
    catalog.refreshIfStale();
    expect(probe).toHaveBeenCalledTimes(1);
    release(models('a/one'));
    await Promise.all([catalog.ready, second]);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('refreshIfStale probes again only after the age, in the background', async () => {
    let now = 1_000_000;
    const probe = vi.fn(async () => models('a/one'));
    const catalog = startOpencodeCatalog(probe, quiet(), vi.fn(), { file, now: () => now });
    await catalog.ready;
    now += OPENCODE_CATALOG_MAX_AGE_MS - 1;
    catalog.refreshIfStale();
    expect(probe).toHaveBeenCalledTimes(1);
    now += 1;
    catalog.refreshIfStale();
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
  });

  it('does nothing without a probe', async () => {
    const catalog = startOpencodeCatalog(undefined, quiet(), vi.fn(), { file });
    await catalog.ready;
    catalog.refreshIfStale();
    await catalog.refresh();
    expect(catalog.current()).toBeNull();
    await expect(readFile(file)).rejects.toThrow();
  });
});
