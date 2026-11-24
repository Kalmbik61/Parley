/**
 * OpenCode sign-in hint (spec 2026-11-12 §4.12). The real `opencode` never runs here: an invented command whose override
 * variable points to a stub script. Output shapes copy the recordings of the mock lab (invented ids, no secrets).
 */
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestInfo } from '../methods/context.js';
import { createProvidersList } from '../methods/providers.js';
import { OPENCODE_AUTH_MAX_AGE_MS, parseOpencodeAuthCount, probeOpencodeAuthCount, startOpencodeAuthHint } from './opencode-auth-hint.js';

const COMMAND = 'parley-fake-opencode-auth';
const OVERRIDE = 'PARLEY_PARLEY_FAKE_OPENCODE_AUTH_BIN';

const STORED = JSON.stringify([{ id: 'demo', name: 'Demo', connections: [{ type: 'credential', id: 'cred_demo', label: 'Demo', method: 'key' }] }]);
const ENV = JSON.stringify([{ id: 'demo2', name: 'Demo 2', connections: [{ type: 'env', name: 'DEMO_API_KEY' }] }]);
const BOTH = JSON.stringify([...JSON.parse(STORED), ...JSON.parse(ENV), { id: 'empty', name: 'Empty', connections: [] }]);

const FAKE = `#!/usr/bin/env node
import fs from 'node:fs';
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n');
const mode = process.env.FAKE_MODE ?? 'ok';
if (mode === 'hang') setInterval(() => {}, 1000);
else if (mode === 'fail') process.exit(1);
else process.stdout.write(process.env.FAKE_OUTPUT ?? '');
`;

let dir = '';
let tmpRoot = '';
const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  PATH: process.env['PATH'] ?? '',
  [OVERRIDE]: path.join(dir, 'fake.mjs'),
  FAKE_LOG: path.join(dir, 'runs.jsonl'),
  ...extra,
});

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'opencode-auth-'));
  tmpRoot = path.join(dir, 'tmp');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(tmpRoot));
  const script = path.join(dir, 'fake.mjs');
  await writeFile(script, FAKE, 'utf8');
  await chmod(script, 0o755);
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('parseOpencodeAuthCount', () => {
  it.each([
    ['signed out', '[]', 0],
    ['a stored credential', STORED, 1],
    ['an env key', ENV, 1],
    ['two integrations and an empty one', BOTH, 2],
  ])('%s', (_name, output, count) => {
    expect(parseOpencodeAuthCount(output)).toBe(count);
  });

  it.each([[''], ['No authenticated integrations'], ['{"a":1}'], ['null'], [null], [42]])('gives null for %j', (value) => {
    expect(parseOpencodeAuthCount(value)).toBeNull();
  });
});

describe('probeOpencodeAuthCount', () => {
  it('runs `auth list --format json --standalone` and returns only the count; never auth export', async () => {
    const count = await probeOpencodeAuthCount(COMMAND, { env: env({ FAKE_OUTPUT: BOTH }), tmpRoot });
    expect(count).toBe(2);
    const runs = (await readFile(path.join(dir, 'runs.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as { argv: string[] });
    expect(runs.map((r) => r.argv)).toEqual([['auth', 'list', '--format', 'json', '--standalone']]);
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it('gives 0 when signed out', async () => {
    expect(await probeOpencodeAuthCount(COMMAND, { env: env({ FAKE_OUTPUT: '[]' }), tmpRoot })).toBe(0);
  });

  it.each([['fail', {}], ['hang', { timeoutMs: 500, killGraceMs: 300 }]])('gives null for mode %s', async (mode, options) => {
    expect(await probeOpencodeAuthCount(COMMAND, { env: env({ FAKE_MODE: mode }), tmpRoot, ...options })).toBeNull();
  });

  it('gives null for text output and for a missing command', async () => {
    expect(await probeOpencodeAuthCount(COMMAND, { env: env({ FAKE_OUTPUT: 'No authenticated integrations\n' }), tmpRoot })).toBeNull();
    expect(await probeOpencodeAuthCount('parley-no-such-opencode', { env: { PATH: '' }, tmpRoot })).toBeNull();
  });
});

describe('startOpencodeAuthHint', () => {
  it('does not probe at start; the first refreshIfStale probes, and a changed count tells the window once', async () => {
    const probe = vi.fn(async () => 2);
    const onChange = vi.fn();
    const hint = startOpencodeAuthHint(probe, onChange, { command: COMMAND });
    expect(probe).not.toHaveBeenCalled();
    expect(hint.current()).toBeNull();
    hint.refreshIfStale();
    hint.refreshIfStale();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith(COMMAND);
    await hint.refresh();
    expect(hint.current()).toBe(2);
    expect(onChange).toHaveBeenCalledTimes(1);
    await hint.refresh();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('probes again only after the age; a failed probe clears the count and tells the window', async () => {
    let now = 1_000_000;
    let answer: number | null = 1;
    const probe = vi.fn(async () => answer);
    const onChange = vi.fn();
    const hint = startOpencodeAuthHint(probe, onChange, { now: () => now });
    await hint.refresh();
    now += OPENCODE_AUTH_MAX_AGE_MS - 1;
    hint.refreshIfStale();
    expect(probe).toHaveBeenCalledTimes(1);
    now += 1;
    answer = null;
    hint.refreshIfStale();
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(hint.current()).toBeNull());
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('a throwing probe is a null count; no probe means nothing happens', async () => {
    const hint = startOpencodeAuthHint(async () => { throw new Error('boom'); }, vi.fn());
    await hint.refresh();
    expect(hint.current()).toBeNull();
    const none = startOpencodeAuthHint(undefined, vi.fn());
    none.refreshIfStale();
    await none.refresh();
    expect(none.current()).toBeNull();
  });
});

describe('providers.list: opencodeAuth', () => {
  const versions = (version: string | null) => ({ ready: Promise.resolve(), get: () => version, fresh: async () => version });
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const name of [OVERRIDE, 'PARLEY_HOME']) saved[name] = process.env[name];
    process.env[OVERRIDE] = path.join(dir, 'fake.mjs');
    process.env['PARLEY_HOME'] = path.join(dir, 'home');
  });
  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const rowOf = async (list: ReturnType<typeof createProvidersList>) => (await list({}, {} as RequestInfo)).providers.find((p) => p.id === 'opencode');

  it('is a count for an installed 2.x once the probe has answered; null before, and the answer never waits', async () => {
    // The entry is available only when its command is found: the override points at a stub script and the version at 2.2.7.
    process.env['PARLEY_OPENCODE_BIN'] = path.join(dir, 'fake.mjs');
    try {
      let release: (n: number) => void = () => {};
      const hint = startOpencodeAuthHint(() => new Promise<number | null>((resolve) => { release = resolve; }), vi.fn());
      const list = createProvidersList(versions('2.2.7') as never, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, hint);
      const first = await rowOf(list);
      expect(first?.available).toBe(true);
      expect(first?.opencodeAuth).toBeNull();
      release(3);
      await hint.refresh();
      expect((await rowOf(list))?.opencodeAuth).toEqual({ connected: 3 });
    } finally {
      delete process.env['PARLEY_OPENCODE_BIN'];
    }
  });

  it('is null and never probed for a missing or 1.x OpenCode; other providers carry no field', async () => {
    const probe = vi.fn(async () => 1);
    const hint = startOpencodeAuthHint(probe, vi.fn());
    const list = createProvidersList(versions('1.19.5') as never, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, hint);
    const rows = (await list({}, {} as RequestInfo)).providers;
    expect(rows.find((p) => p.id === 'opencode')?.opencodeAuth).toBeNull();
    expect(rows.filter((p) => p.id !== 'opencode').every((p) => !('opencodeAuth' in p))).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });
});
