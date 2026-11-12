/**
 * OpenCode sign-in hint (spec 2026-11-12 §4.12). The real `opencode` never runs here: an invented command whose override
 * variable points to a stub script. Output shapes copy the recordings of the mock lab (invented ids, no secrets).
 */
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseOpencodeAuthCount, probeOpencodeAuthCount } from './opencode-auth-hint.js';

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
