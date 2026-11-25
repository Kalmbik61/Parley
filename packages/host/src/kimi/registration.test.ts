import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { installKimiHooks, installKimiMcp, removeKimiHooks, removeKimiMcp } from './registration.js';

let home: string;
const config = { command: '/parley/node', args: ['/parley/mcp/server.js', '--kimi-native'] };
beforeEach(async () => { home = await mkdtemp(path.join(tmpdir(), 'parley-kimi-reg-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
const file = () => path.join(home, 'mcp.json');

it('preserves every byte of other hooks, comments and user preferences on setup and cleanup', async () => {
  const file = path.join(home, 'config.toml');
  const raw = '# Alone\ndefault_permission_mode = "auto" # intentionally\n\n[[hooks]]\nevent = "Stop"\ncommand = "echo unique"';
  const command = "'/parley/node' '/parley/kimi-hook.js'";
  await writeFile(file, raw);
  expect(await installKimiHooks(home, command)).toBe(true);
  const installed = await readFile(file, 'utf8');
  expect(installed.startsWith(raw + '\n')).toBe(true);
  expect(installed).toContain('event = "SessionStart"');
  expect(await installKimiHooks(home, command)).toBe(false);
  expect(await readFile(file, 'utf8')).toBe(installed);
  expect(await removeKimiHooks(home, command)).toBe(true);
  expect(await readFile(file, 'utf8')).toBe(raw);
});

it('adds and removes only the managed entry without persisting launch authority', async () => {
  const user = { mcpServers: { their_tool: { url: 'https://example.invalid/mcp' } }, extra: { untouched: true } };
  await writeFile(file(), JSON.stringify(user));
  expect(await installKimiMcp(home, config)).toBe(true);
  const raw = await readFile(file(), 'utf8');
  expect(JSON.parse(raw)).toEqual({ ...user, mcpServers: { ...user.mcpServers, parley: config } });
  expect(await installKimiMcp(home, config)).toBe(false);
  expect(await readFile(file(), 'utf8')).toBe(raw);
  expect(await removeKimiMcp(home, config)).toBe(true);
  expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual(user);
});

it('does not change a foreign parley entry or follow a symlink', async () => {
  const raw = '{"mcpServers":{"parley":{"command":"foreign"}}}';
  await writeFile(file(), raw);
  await expect(installKimiMcp(home, config)).rejects.toThrow(/already defines.*parley/i);
  expect(await removeKimiMcp(home, config)).toBe(false);
  expect(await readFile(file(), 'utf8')).toBe(raw);
  await rm(file());
  const other = path.join(home, 'other.json');
  await writeFile(other, raw);
  await symlink(other, file());
  await expect(installKimiMcp(home, config)).rejects.toThrow(/regular file/i);
  expect(await readFile(other, 'utf8')).toBe(raw);
});
