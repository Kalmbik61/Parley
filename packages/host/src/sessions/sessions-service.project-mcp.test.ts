/**
 * Серверы MCP из `.mcp.json` при запуске Claude (спека 2026-11-02, 7): удержание до решения человека, решение в файле
 * `--settings` сессии, ни один сервер без решения не включается. Устроено как `sessions-service.consent.test.ts`: план
 * запуска шпионится поверх настоящего.
 */

import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPendingSession, createWork, grantTrust, planLaunch, readMap, workPaths } from '@parley/core';
import type { EventData, EventName, SessionRef } from '@parley/protocol';
import type { ActivityService } from '../activity/activity-service.js';
import type { ConsentsService } from '../consents/consents-service.js';
import { createProjectMcp, type ProjectMcp } from '../consents/project-mcp.js';
import type { HostContext } from '../context.js';
import { createPtyManager } from '../pty/pty-manager.js';
import type { WorksService } from '../works/works-service.js';
import { createSessionsService } from './sessions-service.js';

vi.mock('@parley/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@parley/core')>();
  return { ...actual, planLaunch: vi.fn(actual.planLaunch), planResume: vi.fn(actual.planResume), planNew: vi.fn(actual.planNew) };
});

const STUB = fileURLToPath(new URL('../../test/stub-agent.mjs', import.meta.url));
vi.setConfig({ testTimeout: 30_000 });

let broadcasts: Array<{ event: EventName; data: unknown }> = [];
let project = '';
let sandbox = '';
let extraEnv: string[] = [];
const cleanup: Array<() => Promise<unknown>> = [];
const warn = vi.fn();

function setEnv(key: string, value: string): void {
  process.env[key] = value;
  extraEnv.push(key);
}

function fakeHost(): HostContext {
  return {
    version: '0.0.0',
    startedAt: new Date().toISOString(),
    paths: { dir: '', socket: '', token: '', pid: '', log: '' },
    log: { info: () => {}, warn, error: () => {} },
    clients: () => [],
    liveSessions: () => 0,
    broadcast: (event, data) => broadcasts.push({ event, data: data as EventData<EventName> }),
    onShutdown: () => {},
    shutdown: async () => {},
    busy: () => {},
  };
}

const fakeWorks = (): WorksService => ({
  start: async () => {}, snapshot: () => ({ entries: [], branches: {} }), entry: () => undefined,
  firstReadDone: () => false, onChange: () => () => {}, stop: async () => {},
});
const fakeActivity = (): ActivityService => ({
  start: async () => {}, get: () => undefined, markSeen: () => {}, onChange: () => () => {}, stop: async () => {},
});

/** Службы согласий: `request` для Codex и `requestProjectMcp` для серверов MCP. */
function fakeConsents() {
  const request = vi.fn<ConsentsService['request']>(() => ({ id: 'c-01' }) as never);
  const requestProjectMcp = vi.fn<ConsentsService['requestProjectMcp']>((input) => ({ id: 'c-02', kind: 'project-mcp', ...input }) as never);
  return { request, requestProjectMcp };
}

let userHome = '';
let mcp: ProjectMcp;

beforeEach(async () => {
  sandbox = await realpath(await mkdtemp(path.join(tmpdir(), 'parley-sessions-mcp-')));
  project = path.join(sandbox, 'project');
  userHome = path.join(sandbox, 'user');
  await mkdir(project, { recursive: true });
  await mkdir(userHome, { recursive: true });
  broadcasts = [];
  warn.mockClear();
  setEnv('PARLEY_CLAUDE_BIN', STUB);
  setEnv('PARLEY_CODEX_BIN', STUB);
  setEnv('PARLEY_SKILL_NAVIGATOR', '0');
  setEnv('PARLEY_HOME', path.join(sandbox, 'parley-home'));
  setEnv('STUB_ARGS_FILE', path.join(sandbox, 'args.json'));
  mcp = createProjectMcp({
    home: path.join(sandbox, 'parley-home'),
    userHome,
    claudeConfigDir: path.join(userHome, '.claude'),
    log: { warn },
  });
  vi.mocked(planLaunch).mockClear();
});

afterEach(async () => {
  for (const key of extraEnv) delete process.env[key];
  extraEnv = [];
  for (const run of cleanup.splice(0)) await run();
  await rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const server = (command: string, args: string[] = []) => ({ type: 'stdio', command, args });
async function writeMcp(servers: Record<string, unknown>): Promise<void> {
  await writeFile(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: servers }));
}

async function pendingPeer(provider = 'claude'): Promise<{ workId: string; ref: SessionRef }> {
  const work = await createWork(project, { title: 'Работа', goal: '' });
  const peer = await createPendingSession(project, work.work.id, {
    provider, label: 'Peer', task: 'Implement', parent: null, contextFrom: [],
  });
  return { workId: work.work.id, ref: { projectPath: project, workId: work.work.id, sessionId: peer } };
}

function build(feed: { consents?: ReturnType<typeof fakeConsents> | undefined; withMcp?: boolean } = {}) {
  const consents = feed.consents ?? fakeConsents();
  const pty = createPtyManager(fakeHost());
  const service = createSessionsService(fakeHost(), fakeWorks(), pty, fakeActivity(), {
    consents,
    ...(feed.withMcp === false ? {} : { projectMcp: mcp }),
  });
  cleanup.push(() => service.stopAll());
  return { service, consents, pty };
}

const sessionSettings = async (ref: SessionRef): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(path.join(workPaths(ref.projectPath, ref.workId).dir, 'settings', `${ref.sessionId}.json`), 'utf8')) as Record<string, unknown>;
const lastOptions = (): Record<string, unknown> => vi.mocked(planLaunch).mock.calls.at(-1)?.[3] as unknown as Record<string, unknown>;

describe('launch(): серверы MCP проекта у Claude', () => {
  it('новые серверы: held, карточка со списком, бюджет не занят, план не строится, процесса нет, сессия pending', async () => {
    await writeMcp({ a: server('node', ['a.js']), b: server('node', ['b.js']) });
    const { workId, ref } = await pendingPeer();
    const { service, consents, pty } = build();

    expect(await service.launch(ref, 'launch', { by: 'auto' })).toBe('held');

    expect(consents.requestProjectMcp).toHaveBeenCalledTimes(1);
    const [input, held] = consents.requestProjectMcp.mock.calls[0]!;
    expect(input).toMatchObject({ projectPath: project, repo: project, requestedBy: { source: 'agent', workId, label: 'Peer' } });
    expect(input.servers.map((entry) => entry.name).sort()).toEqual(['a', 'b']);
    expect(input.servers.find((entry) => entry.name === 'a')).toMatchObject({ command: 'node a.js', fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(held).toEqual({ ref, mode: 'launch', by: 'auto' });
    const map = await readMap(project, workId);
    expect(map.sessions.find((session) => session.id === ref.sessionId)?.lifecycle).toBe('pending');
    expect(map.resources?.attempts ?? []).toEqual([]);
    expect(vi.mocked(planLaunch)).not.toHaveBeenCalled();
    expect(pty.get(ref)).toBeUndefined();
  });

  it('requestProjectMcp вернул null (решение уже записано): запуск не удерживается и идёт сразу', async () => {
    await writeMcp({ a: server('node') });
    const { ref } = await pendingPeer();
    const consents = fakeConsents();
    consents.requestProjectMcp.mockReturnValue(null);
    const { service } = build({ consents });

    expect(await service.launch(ref, 'launch', { by: 'auto' })).toBe('started');

    expect(consents.requestProjectMcp).toHaveBeenCalledTimes(1);
    // Решения в хранилище нет, поэтому финальная проверка не включает сервер: он уходит в disabled.
    expect(lastOptions()).toMatchObject({ projectMcp: { enabled: [], disabled: ['a'] } });
  });

  it('create() агента: ответ с held "project-mcp"', async () => {
    await writeMcp({ a: server('node') });
    const { workId } = await pendingPeer();
    const { service } = build();
    const caller = (await readMap(project, workId)).sessions[0]!.id;
    const created = await service.create({ projectPath: project, workId, provider: 'claude', label: 'New', task: 'T', parent: null, requestedBy: caller });
    expect(created.held).toBe('project-mcp');
  });

  it('решение человека: a включён, b выключен — ключи в файле --settings сессии, остальные ключи на месте, общий файл работы чист', async () => {
    await writeMcp({ a: server('node', ['a.js']), b: server('node', ['b.js']) });
    const { ref } = await pendingPeer();
    const { service, consents, pty } = build();
    await service.launch(ref, 'launch', { by: 'auto' });
    const found = consents.requestProjectMcp.mock.calls[0]![0];
    mcp.store.record(found.repo, found.servers.map((entry) => ({ name: entry.name, fingerprint: entry.fingerprint, enabled: entry.name === 'a' })), 'window');

    expect(await service.launch(ref, 'launch', { by: 'auto' })).toBe('started');

    expect(consents.requestProjectMcp).toHaveBeenCalledTimes(1);
    expect(lastOptions()).toMatchObject({ projectMcp: { enabled: ['a'], disabled: ['b'] } });
    const file = await sessionSettings(ref);
    expect(file).toMatchObject({ enabledMcpjsonServers: ['a'], disabledMcpjsonServers: ['b'] });
    expect(file).toHaveProperty('hooks');
    expect(file).toHaveProperty('statusLine');
    // `--settings` указывает именно на файл сессии.
    const plan = await vi.mocked(planLaunch).mock.results.at(-1)!.value as { args: string[] };
    expect(plan.args[plan.args.indexOf('--settings') + 1]).toBe(path.join(workPaths(ref.projectPath, ref.workId).dir, 'settings', `${ref.sessionId}.json`));
    // Общий файл работы ключей не получил: он мог бы достаться сессии из другого репозитория.
    const shared = workPaths(ref.projectPath, ref.workId).settings;
    if (existsSync(shared)) expect(JSON.parse(await readFile(shared, 'utf8'))).not.toHaveProperty('enabledMcpjsonServers');
    expect(pty.get(ref)).toBeDefined();
  });

  it('отказ человека: все выключены — enabled пуст, disabled со всеми серверами, запуск идёт', async () => {
    await writeMcp({ a: server('node'), b: server('node', ['x']) });
    const { ref } = await pendingPeer();
    const { service, consents } = build();
    await service.launch(ref, 'launch');
    const found = consents.requestProjectMcp.mock.calls[0]![0];
    mcp.store.record(found.repo, found.servers.map((entry) => ({ name: entry.name, fingerprint: entry.fingerprint, enabled: false })), 'window');

    expect(await service.launch(ref, 'launch')).toBe('started');
    expect(await sessionSettings(ref)).toMatchObject({ enabledMcpjsonServers: [], disabledMcpjsonServers: ['a', 'b'] });
  });

  it('изменённый отпечаток: карточка снова', async () => {
    await writeMcp({ a: server('node', ['a.js']) });
    const { ref } = await pendingPeer();
    const { service, consents } = build();
    await service.launch(ref, 'launch');
    const found = consents.requestProjectMcp.mock.calls[0]![0];
    mcp.store.record(found.repo, found.servers.map((entry) => ({ name: entry.name, fingerprint: entry.fingerprint, enabled: true })), 'window');
    await writeMcp({ a: server('node', ['EVIL.js']) });

    expect(await service.launch(ref, 'launch')).toBe('held');
    expect(consents.requestProjectMcp).toHaveBeenCalledTimes(2);
    expect(vi.mocked(planLaunch)).not.toHaveBeenCalled();
  });

  it('решение Claude (настройки пользователя): карточки нет, ключей в файле нет', async () => {
    await writeMcp({ a: server('node'), b: server('node') });
    await mkdir(path.join(userHome, '.claude'), { recursive: true });
    await writeFile(path.join(userHome, '.claude', 'settings.json'), JSON.stringify({ enabledMcpjsonServers: ['a'], disabledMcpjsonServers: ['b'] }));
    const { ref } = await pendingPeer();
    const { service, consents } = build();

    expect(await service.launch(ref, 'launch')).toBe('started');

    expect(consents.requestProjectMcp).not.toHaveBeenCalled();
    expect(lastOptions()).not.toHaveProperty('projectMcp');
  });

  it('включение в .claude/settings.local.json проекта решением не считается: карточка есть (случай телефона)', async () => {
    await writeMcp({ a: server('node'), b: server('node') });
    await mkdir(path.join(project, '.claude'), { recursive: true });
    await writeFile(path.join(project, '.claude', 'settings.local.json'), JSON.stringify({ enabledMcpjsonServers: ['a', 'b'] }));
    const { ref } = await pendingPeer();
    const { service, consents } = build();

    expect(await service.launch(ref, 'launch', { by: 'auto' })).toBe('held');
    expect(consents.requestProjectMcp).toHaveBeenCalledTimes(1);
  });

  it('битый .mcp.json: карточки нет, ни один сервер не включён, запись в журнал', async () => {
    await writeFile(path.join(project, '.mcp.json'), '{{ не json');
    const { ref } = await pendingPeer();
    const { service, consents } = build();

    expect(await service.launch(ref, 'launch')).toBe('started');

    expect(consents.requestProjectMcp).not.toHaveBeenCalled();
    expect(lastOptions()).not.toHaveProperty('projectMcp');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('malformed'), expect.anything());
  });

  it('нет .mcp.json: ничего не меняется — ни карточки, ни ключей', async () => {
    const { ref } = await pendingPeer();
    const { service, consents } = build();
    expect(await service.launch(ref, 'launch')).toBe('started');
    expect(consents.requestProjectMcp).not.toHaveBeenCalled();
    expect(lastOptions()).not.toHaveProperty('projectMcp');
  });

  it('без службы карточек серверы без решения не включаются: уходят в disabled, запуск не удерживается', async () => {
    await writeMcp({ a: server('node') });
    const { ref } = await pendingPeer();
    const consents = { request: vi.fn() } as unknown as ReturnType<typeof fakeConsents>;
    const { service } = build({ consents });

    expect(await service.launch(ref, 'launch')).toBe('started');

    expect(lastOptions()).toMatchObject({ projectMcp: { enabled: [], disabled: ['a'] } });
    expect(await sessionSettings(ref)).toMatchObject({ enabledMcpjsonServers: [], disabledMcpjsonServers: ['a'] });
  });

  it('Codex: .mcp.json не читается, карточки серверов нет, ключей в плане нет', async () => {
    await writeMcp({ a: server('node') });
    await grantTrust(project, 'window');
    const { ref } = await pendingPeer('codex');
    const inspect = vi.spyOn(mcp, 'inspect');
    const { service, consents } = build();

    expect(await service.launch(ref, 'launch', { by: 'auto' })).toBe('started');

    expect(inspect).not.toHaveBeenCalled();
    expect(consents.requestProjectMcp).not.toHaveBeenCalled();
    expect(lastOptions()).not.toHaveProperty('projectMcp');
  });

  it('без службы серверов MCP (изолированный сервис) Claude запускается как раньше', async () => {
    await writeMcp({ a: server('node') });
    const { ref } = await pendingPeer();
    const { service, consents } = build({ withMcp: false });
    expect(await service.launch(ref, 'launch')).toBe('started');
    expect(consents.requestProjectMcp).not.toHaveBeenCalled();
    expect(lastOptions()).not.toHaveProperty('projectMcp');
  });
});
