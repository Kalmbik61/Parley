/**
 * Пакет хука, ответ `get_map {field: "packet"}` и список инструментов, который объявляет сервер MCP, — одно и то же при
 * включённых канале агента и навигаторе скиллов. Всё настоящее: рабочий `hostToolContext`, маршрут `/agent/tools`, удалённый
 * исполнитель процесса MCP, путь пакета приёмника хуков и хранилище работы. Возможности запуска хук берёт из состояния хоста
 * (снимок процесса MCP, регистрация канала), а не из своего запроса.
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_TOOLS_PATH, addRoom, addSession, createParleyServer, createRemoteToolRunner, createWork, updateMap, workPaths, type McpContext,
  type ToolRunner,
} from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import { silentLog } from '../../test/feed-fakes.js';
import { hostToolContext } from '../agent/tool-context.js';
import { createToolsEndpoint } from '../agent/tools-endpoint.js';
import { createHookServer, type HookServer } from './hook-server.js';
import { createPacketEndpoint, PACKET_PATH, packetLaunch } from './packet-endpoint.js';

let home = '';
let project = '';
let ref: SessionRef;
let hooks: HookServer | null = null;

const COMPACT = JSON.stringify({ hook_event_name: 'SessionStart', source: 'compact', session_id: 'c-1' });

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
  process.env['PARLEY_HOME'] = home;
  const workId = (await createWork(project, { title: 'Работа', goal: '' })).work.id;
  await updateMap(project, workId, (map) => {
    for (const label of ['лид', 'бэк']) addSession(map, { provider: 'claude', label, task: 'делать' });
    addRoom(map, { title: 'Агенты', creator: 'human', members: ['s-01', 's-02'], lead: 's-01' });
  });
  await mkdir(workPaths(project, workId).events, { recursive: true });
  ref = { projectPath: project, workId, sessionId: 's-02' };
});

afterEach(async () => {
  await hooks?.close();
  hooks = null;
  delete process.env['PARLEY_HOME'];
  await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Хост в миниатюре: те же детали, что в `host.ts`, — рабочий контекст, маршрут инструментов и путь пакета. */
async function boot(options: { channel: boolean }) {
  const toolContextFor = (sessionRef: SessionRef, launch: Parameters<typeof hostToolContext>[1]): Promise<McpContext> =>
    hostToolContext(sessionRef, launch, {
      providerRows: async () => [],
      onWorksChange: () => () => {},
      agentChannel: () => options.channel,
    });
  const tools = createToolsEndpoint({ authenticate: () => ref, contextFor: toolContextFor, log: silentLog() });
  const packet = createPacketEndpoint({
    log: silentLog(),
    enabled: async () => true,
    fault: () => undefined,
    context: (sessionRef, registered) => toolContextFor(sessionRef, packetLaunch(tools.launchOf(sessionRef), registered)),
  });
  hooks = createHookServer({
    log: silentLog(),
    onHook: () => {},
    routes: { [AGENT_TOOLS_PATH]: (req, res) => tools.handle(req, res) },
    guarded: { [PACKET_PATH]: (request) => packet.handle(request) },
  });
  await hooks.listen();
  const origin = hooks.origin()!;
  const token = hooks.register(ref, 'c-1', 'claude', 'rev-1');
  return { origin, token, tools, agent: { url: `${origin}/agent/browser`, token: 'a'.repeat(64) } };
}

function postPacket(origin: string, token: string): Promise<string> {
  const target = new URL(`${origin}${PACKET_PATH}`);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: target.hostname, port: target.port, path: target.pathname, method: 'POST', agent: false,
      headers: { Authorization: `Bearer ${token}`, 'X-Parley-Session': ref.sessionId, 'Content-Length': String(Buffer.byteLength(COMPACT)) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.end(COMPACT);
  });
}

/** Что объявляет сервер MCP процесса сессии: список хоста плюс инструменты канала — `tools/list` настоящего сервера. */
async function declaredBy(runner: ToolRunner, agent: { url: string; token: string } | undefined, skillNavigator: boolean): Promise<string[]> {
  const server = createParleyServer({
    projectPath: ref.projectPath, workId: ref.workId, workDir: workPaths(ref.projectPath, ref.workId).dir,
    sessionId: ref.sessionId, channel: false, ...(agent === undefined ? {} : { agent }), ...(skillNavigator ? { skillNavigator: true } : {}),
  }, runner);
  // Обработчик `tools/list` берётся у сервера напрямую: SDK клиента хосту не нужен.
  const handlers = (server as unknown as { _requestHandlers: Map<string, (request: unknown, extra: unknown) => Promise<{ tools: { name: string }[] }>> })._requestHandlers;
  const answer = await handlers.get('tools/list')!({ method: 'tools/list', params: {} }, {});
  return answer.tools.map((tool) => tool.name);
}

/** Имена и ревизия из пакета. */
function parsePacket(text: string): { names: string[]; revision: string } {
  const revision = /^Room state packet (\S+?),/m.exec(text)?.[1] ?? '';
  const line = /## Tools\n[^\n]*\n([^\n]*)/.exec(text)?.[1] ?? '';
  return { names: line.split(', ').filter(Boolean), revision };
}

const textOf = (result: Awaited<ReturnType<ToolRunner['call']>>): string => (result.content as { text: string }[])[0]!.text;

describe('пакет хука = get_map = список сервера', () => {
  it('канал агента и навигатор включены: те же инструменты канала и find_skill, та же ревизия', async () => {
    const { origin, token, agent, tools } = await boot({ channel: true });
    const remote = createRemoteToolRunner(agent, { skillNavigator: true, agentRevision: 'rev-1' });
    const declared = await declaredBy(remote, agent, true);
    expect(declared).toContain('find_skill');
    for (const name of ['browser_open', 'create_session', 'request_agent_switch', 'create_swarm', 'swarm_add']) expect(declared).toContain(name);
    // Снимок запуска, который прислал процесс MCP, теперь известен хосту.
    expect(tools.launchOf(ref)).toMatchObject({ skillNavigator: true });

    const viaGetMap = parsePacket(textOf(await remote.call('get_map', { field: 'packet' })));
    const viaHook = parsePacket(JSON.parse(await postPacket(origin, token)).hookSpecificOutput.additionalContext);
    expect(viaGetMap.names).toEqual(declared);
    expect(viaHook.names).toEqual(declared);
    expect(viaHook.revision).toBe(viaGetMap.revision);
    expect(viaHook.revision).not.toBe('');
  });

  it('канала и навигатора нет: пакет хука без инструментов канала и без find_skill, как у get_map и сервера', async () => {
    const { origin, token, agent } = await boot({ channel: false });
    const remote = createRemoteToolRunner(agent, { agentRevision: 'rev-1' });
    const declared = await declaredBy(remote, undefined, false);
    expect(declared).not.toContain('find_skill');
    expect(declared).not.toContain('browser_open');
    await remote.list();
    const viaGetMap = parsePacket(textOf(await remote.call('get_map', { field: 'packet' })));
    const viaHook = parsePacket(JSON.parse(await postPacket(origin, token)).hookSpecificOutput.additionalContext);
    expect(viaGetMap.names).toEqual(declared);
    expect(viaHook.names).toEqual(declared);
    expect(viaHook.revision).toBe(viaGetMap.revision);
  });

  it('возможности запуска берутся из состояния хоста, а не из запроса моста: тело с чужими полями ничего не меняет', async () => {
    const { origin, token, agent } = await boot({ channel: true });
    const remote = createRemoteToolRunner(agent, { skillNavigator: true, agentRevision: 'rev-1' });
    await remote.list();
    const plain = parsePacket(JSON.parse(await postPacket(origin, token)).hookSpecificOutput.additionalContext);
    // Тело, которое пытается выключить навигатор и канал: хост его полей не читает.
    const target = new URL(`${origin}${PACKET_PATH}`);
    const forged = JSON.stringify({ hook_event_name: 'SessionStart', source: 'compact', launch: { skillNavigator: false, toolProfile: 'short' }, skillNavigator: false, hasAgentChannel: false, toolProfile: 'short' });
    const answer = await new Promise<string>((resolve, reject) => {
      const req = httpRequest({
        host: target.hostname, port: target.port, path: target.pathname, method: 'POST', agent: false,
        headers: { Authorization: `Bearer ${token}`, 'X-Parley-Session': ref.sessionId, 'Content-Length': String(Buffer.byteLength(forged)) },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });
      req.on('error', reject);
      req.end(forged);
    });
    expect(parsePacket(JSON.parse(answer).hookSpecificOutput.additionalContext)).toEqual(plain);
    expect(plain.names).toContain('find_skill');
  });
});
