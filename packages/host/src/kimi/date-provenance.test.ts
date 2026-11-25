import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, realpath, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { withoutKimiDateContext } from './date-provenance.js';
import type { KimiReplayChunk } from './sessions.js';

const cwd = '/example/Stock Project';
const sessionId = 'session_8fad4eb9-9f07-4c99-8ceb-80dcdf7ace17';
const workspace = `wd_stock-project_${createHash('sha256').update(cwd).digest('hex').slice(0, 12)}`;
const date = { kind: 'injection', variant: 'date_change', disclosure: { kind: 'date' } };
const user = { kind: 'user' };
const header = { type: 'metadata', protocol_version: '1.5', min_protocol_version: '1.5' };
const append = (text: string, origin: object) => ({ type: 'context.append_message', agentId: 'main',
  message: { role: 'user', content: [{ type: 'text', text }], origin } });
const rows = [header, append('human', user), append('identical text', date), append('identical text', user)];
const chunks: readonly KimiReplayChunk[] = [
  { author: 'user', text: 'human' }, { author: 'user', text: 'identical text' }, { author: 'agent', text: 'reply' },
  { author: 'user', text: 'identical text' }, { author: 'agent', text: 'literal prompt reply' },
];
const ndjson = (records: readonly object[]) => records.map((record) => JSON.stringify(record)).join('\n') + '\n';

let scratch: string;
let home: string;
let wire: string;
beforeEach(async () => {
  scratch = await realpath(await mkdtemp('/tmp/parley-kimi-wire-'));
  home = path.join(scratch, 'kimi');
  wire = path.join(home, 'sessions', workspace, sessionId, 'agents', 'main', 'wire.jsonl');
  await mkdir(path.dirname(wire), { recursive: true });
  await writeFile(wire, ndjson(rows));
});
afterEach(async () => { await rm(scratch, { recursive: true, force: true }); });

it('uses ordered provenance to preserve a human message identical to an injection', async () => {
  expect(await withoutKimiDateContext({ home, cwd, sessionId }, chunks)).toEqual([chunks[0], ...chunks.slice(2)]);
});

it.each([
  { type: 'forked', agentId: 'main', time: 1 },
  { type: 'agent.switched', branch: 'next', base: { branch: 'main', line: 2 } },
])('declines wire evidence with the stock $type marker', async (marker) => {
  await writeFile(wire, ndjson([...rows.slice(0, 3), marker, ...rows.slice(3)]));
  expect(await withoutKimiDateContext({ home, cwd, sessionId }, chunks)).toBe(chunks);
});

it.each(['linked leaf', 'linked ancestor', 'hard link', 'oversized', 'too many records', 'unsupported', 'reordered', 'wrong cwd', 'unsafe ID'])('declines %s wire evidence', async (scenario) => {
  const external = path.join(scratch, 'external');
  const binding = { home, cwd, sessionId };
  switch (scenario) {
    case 'linked leaf':
      await rename(wire, external);
      await symlink(external, wire);
      break;
    case 'linked ancestor':
      await rename(path.dirname(wire), external);
      await symlink(external, path.dirname(wire), 'dir');
      break;
    case 'hard link': await link(wire, external); break;
    case 'oversized': await truncate(wire, 8 * 1024 * 1024 + 1); break;
    case 'too many records':
      await writeFile(wire, ndjson([...rows, ...Array.from({ length: 8192 }, () => ({ type: 'plugin.session_start' }))]));
      break;
    case 'unsupported': await writeFile(wire, ndjson([{ ...header, protocol_version: '1.6' }, ...rows.slice(1)])); break;
    case 'reordered': await writeFile(wire, ndjson([header, append('identical text', date), append('human', user), append('identical text', user)])); break;
    case 'wrong cwd': binding.cwd = '/unrelated/Stock Project'; break;
    case 'unsafe ID': binding.sessionId = `../${sessionId}`; break;
  }
  expect(await withoutKimiDateContext(binding, chunks)).toBe(chunks);
});
