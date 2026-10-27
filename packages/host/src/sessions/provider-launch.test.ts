import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearSecret, createPendingSession, createWork, readMap, writeSecret, workPaths, updateMap, plannedWorktree,
  customProviderEntry, accountProviderEntry, writeCustomProviders, customProvidersFile, customProviderDir, PROVIDERS,
  type CustomProviderRecord,
} from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import type { HostContext } from '../context.js';
import type { PtyManager } from '../pty/pty-manager.js';
import type { PtyLaunch } from '../pty/pty-process.js';
import type { WorksService } from '../works/works-service.js';
import type { ActivityService } from '../activity/activity-service.js';
import { createSessionsService } from './sessions-service.js';
import { providerLaunchEnv } from './provider-env.js';

// Чтения хранилища секретов хостом: у аккаунта подписки ключа нет, и `secrets.json` при запуске не читается (спека подписок 5.3).
const secretReads = vi.hoisted(() => ({ ids: [] as string[] }));
vi.mock('@parley/core', async (importOriginal) => {
  const core = await importOriginal<typeof import('@parley/core')>();
  return { ...core, readSecret: (id: Parameters<typeof core.readSecret>[0]) => { secretReads.ids.push(id); return core.readSecret(id); } };
});

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

function service(
  hookUrl = () => 'http://127.0.0.1:1234/hooks',
  watchClaudeRoot: (root: string) => void = () => {},
  signedIn?: (id: string) => boolean | null | Promise<boolean | null>,
) {
  const host = { log: { info() {}, warn() {}, error() {} }, broadcast: (_: string, data: unknown) => notices.push(data) } as unknown as HostContext;
  const pty = {
    get: () => undefined, on: () => () => {},
    start: (ref: SessionRef, launch: PtyLaunch) => {
      launches.push(launch);
      return { ref, pid: process.pid };
    },
  } as unknown as PtyManager;
  return createSessionsService(host, { onChange: () => () => {} } as unknown as WorksService, pty, { markSeen() {}, watchClaudeRoot } as unknown as ActivityService, {
    providerVersions: { ready: Promise.resolve(), get: () => version, fresh: probe },
    hooks: { url: hookUrl, register, unregister() {} },
    ...(signedIn === undefined ? {} : { signedIn }),
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
  probe.mockClear(); register.mockClear(); secretReads.ids.length = 0;
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
    ]) await expect(sessions.create(choice)).rejects.toThrow(/key/i);
    await expect(sessions.create({ ...input(), task: '', parent: 's-01' })).rejects.toThrow(/Child sessions/);
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
      SLASH_COMMAND_TOOL_CHAR_BUDGET: '9999', CLAUDE_CODE_AUTO_MODE_SERVER: '1',
    });
    await service().create(input());
    const launch = launches[0]!;
    expect(launch.env).toMatchObject({
      SLASH_COMMAND_TOOL_CHAR_BUDGET: '1', PARLEY_SKILL_NAVIGATOR: '1', PARLEY_SKILL_LIST_REDUCED: '1',
      ANTHROPIC_AUTH_TOKEN: 'fake-zai-key', ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1', CLAUDE_CODE_AUTO_MODE_SERVER: '0',
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
      // Сценарий про окружение процесса, а не про навигатор (он включён по умолчанию с 2026-10-06): путь с общим файлом GLM.
      PARLEY_SKILL_NAVIGATOR: '0',
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

// Свои провайдеры (спека своих провайдеров 5.2, 6.2, К17–К18).
const kimi: CustomProviderRecord = {
  id: 'custom-kimi', label: 'Kimi', preset: null, baseUrl: 'https://api.moonshot.ai/anthropic', auth: 'bearer',
  models: { opus: 'kimi-k2', sonnet: 'kimi-k2', haiku: 'kimi-k2', subagent: 'kimi-k2' }, contextWindow: null, linkClaude: false,
};
const local: CustomProviderRecord = { ...kimi, id: 'custom-local', label: 'Local', baseUrl: 'http://127.0.0.1:11434' };
const hostEnv = {
  ANTHROPIC_BASE_URL: 'x', ANTHROPIC_API_KEY: 'host', ANTHROPIC_AUTH_TOKEN: 'host-token',
  CLAUDE_CONFIG_DIR: '/u/.claude', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/u/.claude', PATH: '/bin',
};

describe('providerLaunchEnv: свой провайдер', () => {
  const entry = customProviderEntry(kimi, '/p');
  it('чистит ANTHROPIC_*, CLAUDE_SECURESTORAGE_CONFIG_DIR и CLAUDE_CONFIG_DIR хоста, ставит свою папку', () => {
    const env = providerLaunchEnv(entry, hostEnv, {}, 'sk-1');
    expect(env.CLAUDE_CONFIG_DIR).toBe(entry.runner.configDir);
    expect(env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.moonshot.ai/anthropic');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-1');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });
  it("auth 'api-key': ключ в ANTHROPIC_API_KEY, AUTH_TOKEN нет", () => {
    const env = providerLaunchEnv(customProviderEntry({ ...kimi, auth: 'api-key' }, '/p'), hostEnv, {}, 'sk-1');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-1');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });
  it('loopback без ключа: плейсхолдер parley-local в переменной auth', () => {
    const bearer = providerLaunchEnv(customProviderEntry(local, '/p'), hostEnv, {}, null);
    expect(bearer.ANTHROPIC_AUTH_TOKEN).toBe('parley-local');
    const apiKey = providerLaunchEnv(customProviderEntry({ ...local, auth: 'api-key' }, '/p'), hostEnv, {}, null);
    expect(apiKey.ANTHROPIC_API_KEY).toBe('parley-local');
    expect(apiKey.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });
  it('GLM: окружение побайтно как до правки', () => {
    const env = providerLaunchEnv(PROVIDERS.glm, hostEnv, { A: '1' }, 'z-key');
    expect(env).toEqual({
      PATH: '/bin', A: '1', ...PROVIDERS.glm.runner.env,
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1', ANTHROPIC_AUTH_TOKEN: 'z-key',
    });
  });
});

describe('запуск своего провайдера', () => {
  let userDir: string;
  beforeEach(async () => {
    userDir = path.join(home, 'user-claude');
    process.env.CLAUDE_CONFIG_DIR = userDir;
    version = '2.1.302';
    await writeCustomProviders([kimi, local], customProvidersFile(home));
  });
  const customInput = (provider = 'custom-kimi') => ({ ...input(), provider });

  it('ключ в процессе, папка и доверие подготовлены до pty.start; хуки с PARLEY_HOOK_CAPABILITY', async () => {
    await writeSecret('custom:custom-kimi', 'sk-kimi');
    await service().create(customInput());
    const launch = launches[0]!;
    expect(launch.env).toMatchObject({
      CLAUDE_CONFIG_DIR: customProviderDir('custom-kimi', home), ANTHROPIC_AUTH_TOKEN: 'sk-kimi',
      PARLEY_HOOK_CAPABILITY: capability,
    });
    expect(launch.env.PARLEY_HOOK_TOKEN).toBeUndefined();
    const seeded = JSON.parse(await readFile(path.join(customProviderDir('custom-kimi', home), '.claude.json'), 'utf8'));
    expect(seeded.hasCompletedOnboarding).toBe(true);
    const file = launch.args[launch.args.indexOf('--settings') + 1]!;
    expect(await readFile(file, 'utf8')).toContain('PARLEY_HOOK_CAPABILITY');
    expect(launch.args.join(' ')).not.toContain('sk-kimi');
  });
  it('без ключа отказ понятным текстом, процесс не стартует', async () => {
    await expect(service().create(customInput())).rejects.toThrow(/Kimi requires a saved key in Settings/);
    expect(launches).toEqual([]);
  });
  it('loopback без ключа стартует с плейсхолдером', async () => {
    await service().create(customInput('custom-local'));
    expect(launches[0]!.env.ANTHROPIC_AUTH_TOKEN).toBe('parley-local');
  });
  it('ошибка подготовки папки — отказ запуска, не падение хоста; и при resume', async () => {
    await writeSecret('custom:custom-kimi', 'sk-kimi');
    const sessions = service();
    const ref = await sessions.create(customInput());
    await rm(customProviderDir('custom-kimi', home), { recursive: true, force: true });
    await writeFile(customProviderDir('custom-kimi', home), 'not a directory');
    await expect(sessions.launch(ref, 'resume')).rejects.toThrow(/folder/i);
    expect(launches).toHaveLength(1);
  });
  const providerJson = async (id: string): Promise<{ customApiKeyResponses?: { approved: string[]; rejected: string[] }; projects?: Record<string, { hasTrustDialogAccepted?: boolean }> }> =>
    JSON.parse(await readFile(path.join(customProviderDir(id, home), '.claude.json'), 'utf8'));
  const apiKeyLocal: CustomProviderRecord = { ...local, auth: 'api-key' };

  it('api-key, loopback без ключа: плейсхолдер в env и его хвост одобрен (К17)', async () => {
    await writeCustomProviders([apiKeyLocal], customProvidersFile(home));
    await service().create(customInput('custom-local'));
    expect(launches[0]!.env.ANTHROPIC_API_KEY).toBe('parley-local');
    expect((await providerJson('custom-local')).customApiKeyResponses.approved).toEqual(['parley-local']);
  });
  it('api-key с ключом: хвост ключа одобрен; bearer при resume убирает одобрение', async () => {
    const key = 'sk-kimi-0123456789012345678901234567';
    await writeCustomProviders([{ ...kimi, auth: 'api-key' }], customProvidersFile(home));
    await writeSecret('custom:custom-kimi', key);
    const sessions = service();
    const ref = await sessions.create(customInput());
    expect((await providerJson('custom-kimi')).customApiKeyResponses.approved).toEqual([key.slice(-20)]);
    await writeCustomProviders([kimi], customProvidersFile(home));
    await sessions.launch(ref, 'resume');
    expect((await providerJson('custom-kimi')).customApiKeyResponses).toBeUndefined();
  });
  it('доверие к папке копируется из .claude.json человека только для доверенной папки', async () => {
    await writeSecret('custom:custom-kimi', 'sk-kimi');
    await mkdir(userDir, { recursive: true });
    await writeFile(path.join(userDir, '.claude.json'), JSON.stringify({ projects: { [project]: { hasTrustDialogAccepted: true } } }));
    await service().create(customInput());
    expect((await providerJson('custom-kimi')).projects?.[project]?.hasTrustDialogAccepted).toBe(true);
    await writeFile(path.join(userDir, '.claude.json'), JSON.stringify({ projects: {} }));
    await rm(customProviderDir('custom-kimi', home), { recursive: true, force: true });
    await service().create(customInput());
    expect((await providerJson('custom-kimi')).projects?.[project]).toBeUndefined();
  });
  it('обычный claude: окружение запуска то же с custom-providers.json и без него', async () => {
    await service().create({ ...input(), provider: 'claude' });
    await rm(customProvidersFile(home), { force: true });
    await service().create({ ...input(), provider: 'claude' });
    const pick = (env: NodeJS.ProcessEnv) => Object.fromEntries(
      Object.entries(env).filter(([name]) => name.startsWith('ANTHROPIC_') || name.startsWith('CLAUDE_')));
    expect(pick(launches[0]!.env)).toEqual(pick(launches[1]!.env));
    expect(launches[0]!.env.CLAUDE_CONFIG_DIR).toBe(userDir);
  });
  it('корень истории отдаётся индексу логов; сбой наблюдателя не отказывает запуск', async () => {
    await writeSecret('custom:custom-kimi', 'sk-kimi');
    const roots: string[] = [];
    await service(undefined, (root) => { roots.push(root); throw new Error('watch broke'); }).create(customInput());
    expect(roots).toEqual([path.join(customProviderDir('custom-kimi', home), 'projects')]);
    expect(launches).toHaveLength(1);
  });
});

// Аккаунт подписки Claude Code: своя папка без ключа (спека подписок 5.3, К12, К13).
const accountRecord: CustomProviderRecord = { kind: 'claude-account', id: 'custom-claude-2', label: '', link: false };

describe('providerLaunchEnv: аккаунт Claude', () => {
  const account = accountProviderEntry(accountRecord, { claude: PROVIDERS.claude }, '/p');
  const inherited = {
    ...hostEnv, CLAUDE_CODE_OAUTH_TOKEN: 'oauth', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1', PARLEY_HOOK_TOKEN: 'stale',
  };
  it('своя папка, срезанные ключи и OAuth-переменные, без MANAGED_BY_HOST и без ключа (спека 5.3, К12)', () => {
    const env = providerLaunchEnv(account, inherited, {}, null);
    expect(env.CLAUDE_CONFIG_DIR).toBe(account.runner.configDir);
    for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST', 'PARLEY_HOOK_TOKEN']) {
      expect(env[name], name).toBeUndefined();
    }
    expect(env.PATH).toBe('/bin');
  });
  it('без ключа срезается всё CLAUDE_CODE_OAUTH_*: refresh-токен, области, client id (спека 5.3, закалка)', () => {
    const env = providerLaunchEnv(account, {
      ...inherited, CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'refresh', CLAUDE_CODE_OAUTH_SCOPES: 'user:inference', CLAUDE_CODE_OAUTH_CLIENT_ID: 'id',
      CLAUDE_CODE_OTHER: 'kept',
    }, {}, null);
    for (const name of Object.keys(env)) expect(name.startsWith('CLAUDE_CODE_OAUTH_'), name).toBe(false);
    expect(env.CLAUDE_CODE_OTHER).toBe('kept');
  });
  it('даже переданный ключ в окружение аккаунта не попадает', () => {
    const env = providerLaunchEnv(account, inherited, {}, 'sk-stray');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });
  it('обычный claude: ничего не срезается (прежнее поведение)', () => {
    const env = providerLaunchEnv(PROVIDERS.claude, inherited, { A: '1' }, null);
    expect(env).toEqual({ ...inherited, A: '1' });
  });
});

describe('запуск аккаунта подписки', () => {
  const accountInput = () => ({ ...input(), provider: 'custom-claude-2' });
  const accountDir = () => customProviderDir('custom-claude-2', home);
  beforeEach(async () => {
    process.env.CLAUDE_CONFIG_DIR = path.join(home, 'user-claude');
    // Файл настроек аккаунта — свой, а не файл сессии навигатора (он включён по умолчанию).
    process.env.PARLEY_SKILL_NAVIGATOR = '0';
    version = '2.1.304';
    await writeCustomProviders([accountRecord], customProvidersFile(home));
  });

  it('свой токен хуков, свой файл настроек, наблюдатель истории; ключ не читается (спека 5.3, К12, К13)', async () => {
    const roots: string[] = [];
    await service(undefined, (root) => { roots.push(root); }, () => true).create(accountInput());
    const launch = launches[0]!;
    expect(launch.env).toMatchObject({ CLAUDE_CONFIG_DIR: accountDir(), PARLEY_HOOK_CAPABILITY: capability });
    expect(launch.env.PARLEY_HOOK_TOKEN).toBeUndefined();
    expect(launch.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBeUndefined();
    expect(launch.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    const file = launch.args[launch.args.indexOf('--settings') + 1]!;
    expect(file).toBe(path.join(workPaths(project, workId).dir, 'settings-custom-claude-2.json'));
    expect(await readFile(file, 'utf8')).toContain('PARLEY_HOOK_CAPABILITY');
    expect(roots).toEqual([path.join(accountDir(), 'projects')]);
    expect(secretReads.ids).toEqual([]);
    // Папка подготовлена тем же путём, что у своих провайдеров, но одобрять нечего: ключа у аккаунта нет.
    const seeded = JSON.parse(await readFile(path.join(accountDir(), '.claude.json'), 'utf8'));
    expect(seeded.hasCompletedOnboarding).toBe(true);
    expect(seeded.customApiKeyResponses).toBeUndefined();
  });
  it('не вошёл: отказ текстом о входе до записей в карту и до процесса', async () => {
    const before = await readMap(project, workId);
    await expect(service(undefined, undefined, () => false).create(accountInput())).rejects.toThrow(/is not signed in/);
    expect(await readMap(project, workId)).toEqual(before);
    expect(launches).toEqual([]);
    expect(secretReads.ids).toEqual([]);
  });
  it('без службы входа аккаунт считается невошедшим; resume после выхода тоже отказывает', async () => {
    await expect(service().create(accountInput())).rejects.toThrow(/is not signed in/);
    let signed: boolean | null = true;
    const sessions = service(undefined, undefined, () => signed);
    const ref = await sessions.create(accountInput());
    signed = null;
    await expect(sessions.launch(ref, 'resume')).rejects.toThrow(/is not signed in/);
    expect(launches).toHaveLength(1);
  });
  it('состояние входа неизвестно (null): запуск ждёт проверку — вошёл запускается, не вошёл отказывает (спека подписок 10)', async () => {
    // Так хост склеивает кэш службы входа и проверку: `status ?? refresh` (host.ts, `accountSignedIn`).
    const status = (): boolean | null => null;
    const refresh = vi.fn(async () => true);
    await service(undefined, undefined, () => status() ?? refresh()).create(accountInput());
    // Готовность проверяется при создании и при запуске, поэтому не один раз: в хосте оба вопроса делят кэш службы входа.
    expect(refresh).toHaveBeenCalled();
    expect(launches).toHaveLength(1);

    const refused = vi.fn(async () => false);
    const before = await readMap(project, workId);
    await expect(service(undefined, undefined, () => status() ?? refused()).create(accountInput())).rejects.toThrow(/is not signed in/);
    expect(refused).toHaveBeenCalled();
    expect(launches).toHaveLength(1);
    expect(await readMap(project, workId)).toEqual(before);
  });
  it('вход спрашивается только у аккаунтов: запуск провайдера с ключом службу входа не зовёт', async () => {
    await writeSecret('zai', 'fake-key');
    version = '2.1.304';
    const asked = vi.fn((): boolean | null => null);
    await service(undefined, undefined, asked).create(input());
    expect(launches).toHaveLength(1);
    expect(asked).not.toHaveBeenCalled();
  });
});
