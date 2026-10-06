import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSecret, createPendingSession, createWork, readMap, writeSecret, workPaths, updateMap, plannedWorktree } from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import type { HostContext } from '../context.js';
import type { PtyManager } from '../pty/pty-manager.js';
import type { PtyLaunch } from '../pty/pty-process.js';
import type { WorksService } from '../works/works-service.js';
import type { ActivityService } from '../activity/activity-service.js';
import { createSessionsService } from './sessions-service.js';

let home: string;
let project: string;
let workId: string;
let binary: string;
let launches: PtyLaunch[];
let notices: unknown[];
let version: string | null;
const savedEnv = { ...process.env };
const capability = 'b'.repeat(64);
const probe = vi.fn(async () => version);
const register = vi.fn(() => capability);

function service(hookUrl = () => 'http://127.0.0.1:1234/hooks') {
  const host = { log: { info() {}, warn() {}, error() {} }, broadcast: (_: string, data: unknown) => notices.push(data) } as unknown as HostContext;
  const pty = {
    get: () => undefined, on: () => () => {},
    start: (ref: SessionRef, launch: PtyLaunch) => {
      launches.push(launch);
      return { ref, pid: process.pid };
    },
  } as unknown as PtyManager;
  return createSessionsService(host, { onChange: () => () => {} } as unknown as WorksService, pty, { markSeen() {} } as unknown as ActivityService, {
    providerVersions: { ready: Promise.resolve(), get: () => version, fresh: probe },
    hooks: { url: hookUrl, register, unregister() {} },
  });
}
const input = () => ({ projectPath: project, workId, provider: 'glm', label: '', task: 'test', parent: null });
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-glm-launch-'));
  project = path.join(home, 'project');
  process.env.PARLEY_HOME = home;
  binary = path.join(home, 'claude');
  await writeFile(binary, '#!/bin/sh\necho "2.1.287 (Claude Code)"\n', { mode: 0o755 });
  process.env.PARLEY_CLAUDE_BIN = binary;
  const work = await createWork(project, { title: 'test', goal: '' });
  workId = work.work.id;
  launches = []; notices = []; version = '2.1.287';
  probe.mockClear(); register.mockClear();
});
afterEach(async () => {
  for (const name of Object.keys(process.env)) if (!(name in savedEnv)) delete process.env[name];
  Object.assign(process.env, savedEnv);
  await rm(home, { recursive: true, force: true });
});

describe('GLM launch boundaries', () => {
  it.each(['--bare', '--safe-mode=true', '--setting-sources='])('refuses GLM template %s before creating a session or probing', async (flag) => {
    await writeFile(path.join(home, 'providers.json'), JSON.stringify({ glm: { resumeArgs: [flag] } }));
    const before = await readMap(project, workId);
    await expect(service().create(input())).rejects.toThrow(/unsupported/);
    expect(await readMap(project, workId)).toEqual(before);
    expect(probe).not.toHaveBeenCalled();
    expect(launches).toEqual([]);
  });
  it('missing key refuses every create branch before work/session changes', async () => {
    const before = await readMap(project, workId);
    const worksBefore = await readdir(path.join(project, '.parley', 'works'));
    const sessions = service();
    for (const choice of [
      input(), { ...input(), task: '' }, { ...input(), task: '', workId: null },
      { ...input(), task: '', parent: 's-01' },
    ]) await expect(sessions.create(choice)).rejects.toThrow(/key/i);
    expect(await readMap(project, workId)).toEqual(before);
    expect(await readdir(path.join(project, '.parley', 'works'))).toEqual(worksBefore);
    expect(launches).toEqual([]);
  });
  it.each(['2.1.286', null, 'unknown'])('unsupported CLI %s refuses before map writes', async (value) => {
    version = value;
    await writeSecret('zai', 'fake-key');
    const before = await readMap(project, workId);
    await expect(service().create(input())).rejects.toThrow(/2\.1\.287/);
    expect(await readMap(project, workId)).toEqual(before);
    expect(register).not.toHaveBeenCalled();
    expect(launches).toEqual([]);
  });
  it('custom command refuses before map writes or probing', async () => {
    await writeFile(path.join(home, 'providers.json'), JSON.stringify({ glm: { command: 'wrapper' } }));
    const before = await readMap(project, workId);
    await expect(service().create(input())).rejects.toThrow(/claude/);
    expect(await readMap(project, workId)).toEqual(before);
    expect(probe).not.toHaveBeenCalled();
  });
  it('rechecks removed key on launch, wake-style resume, new and interrupted resume before worktree/settings/hooks', async () => {
    await writeSecret('zai', 'fake-key');
    const id = await createPendingSession(project, workId, { provider: 'glm', label: '', task: '', parent: null, contextFrom: [] });
    await updateMap(project, workId, (map) => {
      const session = map.sessions[0]!;
      session.worktree = plannedWorktree(project, workId, id, 'main', path.join(home, 'trees'));
    });
    const ref = { projectPath: project, workId, sessionId: id };
    const before = await readMap(project, workId);
    await clearSecret('zai');
    const sessions = service();
    for (const mode of ['launch', 'resume', 'new'] as const) await expect(sessions.launch(ref, mode)).rejects.toThrow(/key/i);
    expect(await readMap(project, workId)).toEqual(before);
    expect(register).not.toHaveBeenCalled();
    expect(launches).toEqual([]);
    expect(notices).toContainEqual(expect.objectContaining({ kind: 'launch-failed' }));
    await updateMap(project, workId, (map) => { map.sessions[0]!.lifecycle = 'sleeping'; });
    await sessions.resumeInterrupted([ref]);
    expect(launches).toEqual([]);
  });
  it('skill navigator: the list budget reaches the GLM process while provider routing and selectors are still scrubbed', async () => {
    await writeSecret('zai', 'fake-zai-key');
    Object.assign(process.env, {
      HOME: home, PARLEY_SKILL_NAVIGATOR: '1', CLAUDE_CONFIG_DIR: '/wrong', ANTHROPIC_MODEL: 'wrong',
      SLASH_COMMAND_TOOL_CHAR_BUDGET: '9999',
    });
    await service().create(input());
    const launch = launches[0]!;
    expect(launch.env).toMatchObject({
      SLASH_COMMAND_TOOL_CHAR_BUDGET: '1', PARLEY_SKILL_NAVIGATOR: '1', PARLEY_SKILL_LIST_REDUCED: '1',
      ANTHROPIC_AUTH_TOKEN: 'fake-zai-key', ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
    });
    expect(launch.env['CLAUDE_CONFIG_DIR']).toBeUndefined();
    expect(launch.env['ANTHROPIC_MODEL']).toBeUndefined();
    const file = launch.args[launch.args.indexOf('--settings') + 1]!;
    const settings = JSON.parse(await readFile(file, 'utf8'));
    expect(settings.model).toBe('glm-5.3[1m]');
    expect(JSON.stringify(settings)).toContain('PARLEY_HOOK_CAPABILITY');
  });
  it.each(['0', '1'])('final env is authoritative and honors subprocess scrub=%s', async (scrub) => {
    await writeSecret('zai', 'fake-zai-key');
    Object.assign(process.env, {
      anthropic_auth_token: 'wrong', ANTHROPIC_API_KEY: 'wrong', ANTHROPIC_MODEL: 'wrong',
      AnThRoPiC_Base_Url: 'wrong', claude_code_use_bedrock: '1', CLAUDE_CODE_OAUTH_TOKEN: 'wrong',
      CLAUDE_CODE_SIMPLE: '1', CLAUDE_CONFIG_DIR: '/wrong', CLAUDE_CODE_HOST_CREDS_FILE: '/wrong',
      CLAUDE_CODE_HOST_AUTH_ENV_VAR: 'STALE_AUTH', STALE_AUTH: 'wrong', PARLEY_HOOK_TOKEN: 'stale',
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: scrub, HTTPS_PROXY: 'https://proxy.test', AWS_ACCESS_KEY_ID: 'sdk',
    });
    const ref = await service().create(input());
    const launch = launches[0]!;
    expect(launch.env).toMatchObject({
      ANTHROPIC_AUTH_TOKEN: 'fake-zai-key', ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1', CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: scrub,
      PARLEY_HOOK_CAPABILITY: capability, HTTPS_PROXY: 'https://proxy.test', AWS_ACCESS_KEY_ID: 'sdk',
    });
    for (const name of ['anthropic_auth_token', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'AnThRoPiC_Base_Url', 'claude_code_use_bedrock', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_SIMPLE', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_HOST_CREDS_FILE', 'CLAUDE_CODE_HOST_AUTH_ENV_VAR', 'PARLEY_HOOK_TOKEN']) expect(launch.env[name]).toBeUndefined();
    expect(launch.args.join(' ')).not.toContain('fake-zai-key');
    const settings = await readFile(path.join(workPaths(project, workId).dir, 'settings-glm.json'), 'utf8');
    expect(settings).toContain('PARLEY_HOOK_CAPABILITY');
    expect(settings).not.toContain('fake-zai-key');
    expect(JSON.stringify(await readMap(project, workId))).not.toContain('fake-zai-key');
    await clearSecret('zai');
    await expect(service().launch(ref, 'resume')).rejects.toThrow(/key/i);
  });
  it('ordinary Claude and Codex never receive the saved Z.ai key', async () => {
    await writeSecret('zai', 'fake-zai-key');
    process.env.PARLEY_CODEX_BIN = binary;
    for (const provider of ['claude', 'codex']) await service().create({ ...input(), provider });
    expect(launches).toHaveLength(2);
    expect(launches.every((launch) => launch.env.ANTHROPIC_AUTH_TOKEN !== 'fake-zai-key')).toBe(true);
    expect(launches[0]!.env.PARLEY_HOOK_TOKEN).toBe(capability);
  });
  it('preserves the inherited managed policy pointer and its original env-name casing', async () => {
    await writeSecret('zai', 'fake-key');
    Object.assign(process.env, {
      CLAUDE_CODE_MANAGED_SETTINGS_PATH: '/fake-policy/managed-settings.json',
      claude_code_managed_settings_path: '/fake-policy/lowercase-settings.json',
    });
    await service().create(input());
    expect(launches[0]!.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH).toBe('/fake-policy/managed-settings.json');
    expect(launches[0]!.env.claude_code_managed_settings_path).toBe('/fake-policy/lowercase-settings.json');
  });
  it('key deletion during preparation still refuses before hook registration and PTY startup', async () => {
    await writeSecret('zai', 'fake-key');
    const sessions = service(() => {
      rmSync(path.join(home, 'secrets.json'));
      return 'http://127.0.0.1:1234/hooks';
    });
    await expect(sessions.create(input())).rejects.toThrow(/key/i);
    expect(register).not.toHaveBeenCalled();
    expect(launches).toEqual([]);
  });
  it('each launch uses the latest key and repeats the CLI probe', async () => {
    await writeSecret('zai', 'first-key');
    const sessions = service();
    const ref = await sessions.create(input());
    await writeSecret('zai', 'rotated-key');
    await sessions.launch(ref, 'resume');
    expect(launches.map((launch) => launch.env.ANTHROPIC_AUTH_TOKEN)).toEqual(['first-key', 'rotated-key']);
    version = '2.1.286';
    await expect(sessions.launch(ref, 'resume')).rejects.toThrow(/2\.1\.287/);
    expect(launches).toHaveLength(2);
    expect(probe).toHaveBeenCalledTimes(4);
  });
});
