/**
 * Привязка сессии Codex к её логу по `_meta.threadId` (спека комнат Organic, 3.6, «Привязка к
 * логу»): Codex кладёт id треда в `_meta` каждого `tools/call` к любому MCP-серверу, и сервер
 * `parley-mcp` узнаёт его при первом же вызове — без гадания по cwd и времени запуска.
 */

import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addSession } from '../work/map.js';
import { createWork, readMap, updateMap, workPaths } from '../work/store.js';
import { createParleyServer } from './tools.js';

const THREAD = '019ce3d5-584a-7be2-922e-b8185a8d7c19';
const OTHER_THREAD = '019ce3d5-9999-7be2-922e-b8185a8d7c00';
const SUBAGENT_THREAD = '019ce3d5-aaaa-7be2-922e-b8185a8d0003';

let home = '';
let project = '';
let workId = '';
const opened: Array<{ client: Client; server: Server }> = [];

async function connect(sessionId: string | null): Promise<Client> {
  const server = createParleyServer({
    projectPath: project,
    workId,
    workDir: workPaths(project, workId).dir,
    sessionId,
    pollMs: 40,
    channel: false,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'codex-test', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  opened.push({ client, server });
  return client;
}

/** Вызов инструмента с `_meta`, как его делает Codex: тред и сессия рядом. */
const call = (client: Client, meta: Record<string, unknown> | undefined, name = 'get_map') =>
  client.callTool({ name, arguments: {}, ...(meta === undefined ? {} : { _meta: meta }) });

async function providerSessionId(id: string): Promise<string | null | undefined> {
  return (await readMap(project, workId)).sessions.find((session) => session.id === id)
    ?.providerSessionId;
}

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
  process.env['HARNAS_HOME'] = home;
  workId = (await createWork(project, { title: 'Работа', goal: '' })).work.id;
  await updateMap(project, workId, (map) => {
    addSession(map, { provider: 'codex', label: 'кодекс', task: 'сделать' });
    addSession(map, { provider: 'claude', label: 'клод', task: 'сделать' });
  });
});

afterEach(async () => {
  for (const { client, server } of opened.splice(0)) {
    await client.close();
    await server.close();
  }
  delete process.env['HARNAS_HOME'];
  await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('_meta.threadId → providerSessionId', () => {
  it('первый tools/call сессии codex записывает id треда в карту', async () => {
    const client = await connect('s-01');
    expect(await providerSessionId('s-01')).toBeNull();

    await call(client, { threadId: THREAD, sessionId: THREAD });
    expect(await providerSessionId('s-01')).toBe(THREAD);
  });

  it('id из `_meta` приходит с любым инструментом, а не только с get_map', async () => {
    const client = await connect('s-01');
    await call(client, { threadId: THREAD }, 'read_guide');
    expect(await providerSessionId('s-01')).toBe(THREAD);
  });

  it('id привязан — второй вызов с другим id его не перезаписывает', async () => {
    const client = await connect('s-01');
    await call(client, { threadId: THREAD });
    await call(client, { threadId: OTHER_THREAD });
    expect(await providerSessionId('s-01')).toBe(THREAD);
  });

  it('в карте уже id, найденный запасным путём хоста (cwd и время), — id из `_meta` авторитетнее и заменяет его', async () => {
    // Запасной путь срабатывает на первом же логе Codex, за секунды до первого вызова модели, и рядом с
    // ещё одним агентом в том же каталоге привязывает чужой тред. `_meta.threadId` — тред этого процесса.
    await updateMap(project, workId, (map) => {
      const session = map.sessions.find((item) => item.id === 's-01');
      if (session !== undefined) session.providerSessionId = OTHER_THREAD;
    });
    const client = await connect('s-01');
    await call(client, { threadId: THREAD, sessionId: THREAD });
    expect(await providerSessionId('s-01')).toBe(THREAD);

    // Один раз за жизнь сервера: следующие вызовы карту не трогают.
    await call(client, { threadId: OTHER_THREAD, sessionId: OTHER_THREAD });
    expect(await providerSessionId('s-01')).toBe(THREAD);
  });

  it('в карте уже тот же id (resume) — карта не переписывается', async () => {
    await updateMap(project, workId, (map) => {
      const session = map.sessions.find((item) => item.id === 's-01');
      if (session !== undefined) session.providerSessionId = THREAD;
    });
    const before = (await stat(workPaths(project, workId).map)).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 30));
    const client = await connect('s-01');
    await call(client, { threadId: THREAD, sessionId: THREAD });
    expect(await providerSessionId('s-01')).toBe(THREAD);
    expect((await stat(workPaths(project, workId).map)).mtimeMs).toBe(before);
  });

  it('вызов подагента не привязывает свой тред: `_meta.sessionId` — корневой тред — не совпадает с threadId', async () => {
    const client = await connect('s-01');
    await call(client, { threadId: SUBAGENT_THREAD, sessionId: THREAD });
    expect(await providerSessionId('s-01')).toBeNull();

    // Вызов корневого треда привязывает: подагент не «съел» единственную попытку.
    await call(client, { threadId: THREAD, sessionId: THREAD });
    expect(await providerSessionId('s-01')).toBe(THREAD);
  });

  it('вызов подагента не заменяет и уже найденный корневой тред', async () => {
    await updateMap(project, workId, (map) => {
      const session = map.sessions.find((item) => item.id === 's-01');
      if (session !== undefined) session.providerSessionId = THREAD;
    });
    const client = await connect('s-01');
    await call(client, { threadId: SUBAGENT_THREAD, sessionId: THREAD });
    expect(await providerSessionId('s-01')).toBe(THREAD);
  });

  it('`_meta.sessionId` нет или на uuid не похож — привязывается threadId, как и раньше', async () => {
    const first = await connect('s-01');
    await call(first, { threadId: THREAD });
    expect(await providerSessionId('s-01')).toBe(THREAD);

    await updateMap(project, workId, (map) => {
      const session = map.sessions.find((item) => item.id === 's-01');
      if (session !== undefined) session.providerSessionId = null;
    });
    const second = await connect('s-01');
    await call(second, { threadId: OTHER_THREAD, sessionId: 'не-uuid' });
    expect(await providerSessionId('s-01')).toBe(OTHER_THREAD);
  });

  it('первый вызов без threadId, второй с ним — привязка случается на втором', async () => {
    const client = await connect('s-01');
    await call(client, undefined);
    await call(client, {});
    expect(await providerSessionId('s-01')).toBeNull();

    await call(client, { threadId: THREAD });
    expect(await providerSessionId('s-01')).toBe(THREAD);
  });

  it('id в верхнем регистре приводится к нижнему: так лог-файл называет его Codex', async () => {
    const client = await connect('s-01');
    await call(client, { threadId: THREAD.toUpperCase() });
    expect(await providerSessionId('s-01')).toBe(THREAD);
  });

  it('сессия не codex — `_meta.threadId` игнорируется', async () => {
    const client = await connect('s-02');
    await call(client, { threadId: THREAD });
    expect(await providerSessionId('s-02')).toBeNull();
  });

  it('id не похож на uuid — в карту не идёт: он потом уходит аргументом `codex resume`', async () => {
    const client = await connect('s-01');
    for (const bad of [
      '--yolo',
      '../../x',
      '',
      ' ',
      'не-uuid',
      `${THREAD}; rm -rf /`,
      42,
      null,
      {},
    ]) {
      await call(client, { threadId: bad });
    }
    expect(await providerSessionId('s-01')).toBeNull();
  });

  it('сервер без сессии (HARNAS_SESSION_ID пуст) ничего не привязывает и не падает', async () => {
    const client = await connect(null);
    const result = await call(client, { threadId: THREAD });
    expect(result.isError).not.toBe(true);
    expect(await providerSessionId('s-01')).toBeNull();
  });

  it('сессии нет в карте — вызов инструмента не падает из-за привязки', async () => {
    const client = await connect('s-77');
    const result = await call(client, { threadId: THREAD });
    expect(result.isError).not.toBe(true);
  });

  it('привязка сделана — карта больше не переписывается (её читают наблюдатели окна)', async () => {
    const client = await connect('s-01');
    await call(client, { threadId: THREAD });
    const before = (await stat(workPaths(project, workId).map)).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 30));
    await call(client, { threadId: THREAD });
    await call(client, { threadId: OTHER_THREAD });
    expect((await stat(workPaths(project, workId).map)).mtimeMs).toBe(before);
  });

  it('вызов инструмента отвечает как обычно — привязка ответ не меняет', async () => {
    const client = await connect('s-01');
    const withMeta = await call(client, { threadId: THREAD });
    const without = await call(client, undefined);
    const sessionOf = (result: Awaited<ReturnType<typeof call>>): unknown =>
      (
        JSON.parse((result.content as Array<{ text: string }>)[0]?.text ?? '{}') as {
          sessionId?: string;
        }
      ).sessionId;
    expect(withMeta.isError).not.toBe(true);
    expect(sessionOf(withMeta)).toBe('s-01');
    expect(sessionOf(without)).toBe('s-01');
  });
});
