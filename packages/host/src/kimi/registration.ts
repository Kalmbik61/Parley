import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { MCP_SERVER_ENTRY, validKimiConfigToml } from '@parley/core';
import { HostError } from '../errors.js';

interface Entry { command: string; args: string[]; deferred?: false }
type Json = Record<string, unknown>;
type Source = { raw: string | undefined; mode: number };
type Config = Source & { document: Json; servers: Json };
const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const setup = new Map<string, Promise<void>>();

async function readSource(file: string): Promise<Source> {
  let fd;
  try {
    fd = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { raw: undefined, mode: 0o600 };
    if (code === 'ELOOP') throw new HostError('conflict', 'Kimi configuration must be a regular file to install the Parley entry.');
    throw error;
  }
  try {
    const stat = await fd.stat();
    if (!stat.isFile()) throw new HostError('conflict', 'Kimi configuration is not a regular file.');
    if (stat.size > 1024 * 1024) throw new HostError('conflict', 'Kimi configuration is too large to update safely.');
    return { raw: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await fd.readFile()), mode: stat.mode & 0o777 };
  } finally {
    await fd.close();
  }
}

async function readConfig(file: string): Promise<Config> {
  const before = await readSource(file);
  try {
    const document: unknown = before.raw === undefined ? {} : JSON.parse(before.raw);
    if (!isRecord(document) || ('mcpServers' in document && !isRecord(document.mcpServers))) throw new Error();
    return { ...before, document, servers: isRecord(document.mcpServers) ? document.mcpServers : {} };
  } catch {
    throw new HostError('conflict', 'Kimi mcp.json is not a valid MCP configuration. It was not changed.');
  }
}

async function store(file: string, before: Source, next: string): Promise<void> {
  const tmp = path.join(path.dirname(file), `.parley-mcp-${randomUUID()}.tmp`);
  await writeFile(tmp, next, { flag: 'wx', mode: before.mode });
  try {
    if ((await readSource(file)).raw !== before.raw) throw new HostError('conflict', 'Kimi configuration changed during registration.');
    if (before.raw === undefined) await link(tmp, file);
    else await rename(tmp, file);
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

export async function installKimiMcp(home: string, entry: Entry): Promise<boolean> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, 'mcp.json');
  const before = await readConfig(file);
  if (isDeepStrictEqual(before.servers.parley, entry)) return false;
  if (Object.hasOwn(before.servers, 'parley')) throw new HostError('conflict', 'Kimi mcp.json already defines a foreign parley entry. It was not changed.');
  await store(file, before, JSON.stringify({ ...before.document, mcpServers: { ...before.servers, parley: entry } }, null, 2) + '\n');
  return true;
}

export async function removeKimiMcp(home: string, entry: Entry): Promise<boolean> {
  const file = path.join(home, 'mcp.json');
  const before = await readConfig(file);
  if (!isDeepStrictEqual(before.servers.parley, entry)) return false;
  const servers = { ...before.servers };
  delete servers.parley;
  await store(file, before, JSON.stringify({ ...before.document, mcpServers: servers }, null, 2) + '\n');
  return true;
}

export const KIMI_HOOK_EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop', 'StopFailure', 'Interrupt', 'PreCompact', 'PostCompact'] as const;
const begin = '# >>> Parley managed Kimi hooks >>>';
const end = '# <<< Parley managed Kimi hooks <<<';
const shellArg = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
export const KIMI_HOOK_COMMAND = `${shellArg(process.execPath)} ${shellArg(fileURLToPath(new URL('../../dist/kimi/hook-bridge.js', import.meta.url)))}`;
export const KIMI_MCP_REGISTRATION = { command: process.execPath, args: [MCP_SERVER_ENTRY, '--kimi-native'], deferred: false as const };

function hookBlock(command: string): string {
  return `\n${begin}\n${KIMI_HOOK_EVENTS.map(event => `[[hooks]]\nevent = "${event}"\ncommand = ${JSON.stringify(command)}\ntimeout = 4\n`).join('\n')}${end}\n`;
}

export async function installKimiHooks(home: string, command: string): Promise<boolean> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, 'config.toml');
  const before = await readSource(file);
  const raw = before.raw ?? '';
  const block = hookBlock(command);
  if (raw.includes(block)) return false;
  const next = raw + block;
  if (raw.includes(begin) || raw.includes(end) || !validKimiConfigToml(next)) {
    throw new HostError('conflict', 'The Parley hook block cannot be added to Kimi config.toml without changing existing settings.');
  }
  await store(file, before, next);
  return true;
}

export async function removeKimiHooks(home: string, command: string): Promise<boolean> {
  const file = path.join(home, 'config.toml');
  const before = await readSource(file);
  const block = hookBlock(command);
  if (!before.raw?.includes(block)) return false;
  await store(file, before, before.raw.replace(block, ''));
  return true;
}

export async function prepareKimiRegistration(home: string, cwd: string): Promise<void> {
  const project = await readConfig(path.join(cwd, '.kimi-code', 'mcp.json'));
  if (Object.hasOwn(project.servers, 'parley')) {
    throw new HostError('conflict', 'This project defines a parley MCP entry that would override the managed Kimi registration. It was not changed.');
  }
  const task = (setup.get(home) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const installed = await installKimiHooks(home, KIMI_HOOK_COMMAND);
    try { await installKimiMcp(home, KIMI_MCP_REGISTRATION); }
    catch (error) {
      if (installed) await removeKimiHooks(home, KIMI_HOOK_COMMAND).catch(() => {});
      throw error;
    }
  });
  setup.set(home, task);
  try { await task; }
  finally { if (setup.get(home) === task) setup.delete(home); }
}
