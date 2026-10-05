/**
 * Совместимость (R3, R5): сессия, поднятая прежней сборкой, живёт дальше. Её `mcp/<sid>.json` задаёт
 * серверу только `HARNAS_*`, а работа лежит в `<проект>/.harnas/works/<id>/` — новый сервер обязан
 * прочитать и то, и другое, а не завести рядом второй каталог состояния.
 */

import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addSession } from '../work/map.js';
import { mcpConfigJson } from '../work/mcp-config.js';
import { createWork, readMap, updateMap, workPaths } from '../work/store.js';
import type { WorkMap } from '../work/types.js';
import { contextFromEnv } from './context.js';
import { createParleyServer } from './tools.js';

let home = '';
let project = '';
let workId = '';
const opened: { client: Client; server: ReturnType<typeof createParleyServer> }[] = [];

const exists = async (target: string): Promise<boolean> =>
  stat(target).then(
    () => true,
    () => false,
  );

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
  process.env.PARLEY_HOME = home;
});

afterEach(async () => {
  for (const { client, server } of opened.splice(0)) {
    await client.close();
    await server.close();
  }
  delete process.env.PARLEY_HOME;
  await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Проект прежней сборки: каталог состояния `.harnas`, в нём работа и сессия `s-01`. */
async function legacyProject(): Promise<string> {
  await mkdir(path.join(project, '.harnas'));
  workId = (await createWork(project, { title: 'Старая работа', goal: 'цель' })).work.id;
  await updateMap(project, workId, (map) => {
    addSession(map, { provider: 'claude', label: 'план', task: 'составить план' });
  });
  return workPaths(project, workId).dir;
}

/** Окружение сервера ровно из сохранённого старого конфига (`mcp/<sid>.json` прежней сборки): только `HARNAS_*`. */
function savedEnv(workDir: string, extra: Record<string, string> = {}): Record<string, string> {
  return { HARNAS_WORK_DIR: workDir, HARNAS_SESSION_ID: 's-01', ...extra };
}

async function connect(env: NodeJS.ProcessEnv): Promise<Client> {
  const server = createParleyServer({ ...contextFromEnv(env), pollMs: 40 });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  opened.push({ client, server });
  return client;
}

async function callOk(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { text?: string }[])[0]?.text ?? '';
  expect(result.isError === true, text).toBe(false);
  return JSON.parse(text) as Record<string, unknown>;
}

describe('сохранённый mcp/<sid>.json прежней сборки (только HARNAS_*, каталог .harnas)', () => {
  it('раскладка проекта прежняя: createWork в проекте с .harnas не заводит .parley', async () => {
    const workDir = await legacyProject();

    expect(workDir).toBe(path.join(project, '.harnas', 'works', workId));
    expect(await exists(path.join(project, '.parley'))).toBe(false);
  });

  it('contextFromEnv по HARNAS_* и каталогу .harnas: проект, работа, сессия, звонок', async () => {
    const workDir = await legacyProject();

    expect(contextFromEnv(savedEnv(workDir))).toEqual({
      projectPath: project,
      workId,
      workDir,
      sessionId: 's-01',
      channel: false,
      // Старой сборки нет настройки навигатора скиллов: выключен, ревизии нативного контекста нет.
      skillNavigator: false,
    });
    expect(contextFromEnv(savedEnv(workDir, { HARNAS_CHANNEL: '1' })).channel).toBe(true);
  });

  it('сервер по этому окружению отдаёт карту и принимает report в те же файлы; .parley не появляется', async () => {
    const workDir = await legacyProject();
    const client = await connect(savedEnv(workDir));

    const got = await callOk(client, 'get_map');
    expect(got['sessionId']).toBe('s-01');
    expect((got['map'] as WorkMap).work.title).toBe('Старая работа');

    await callOk(client, 'report', { status: 'progress', summary: 'середина' });

    expect((await readMap(project, workId)).sessions[0]?.summary).toBe('середина');
    expect(JSON.parse(await readFile(path.join(workDir, 'map.json'), 'utf8')).sessions[0].summary).toBe('середина');
    expect(await exists(path.join(project, '.parley'))).toBe(false);
  });

  it('PARLEY_* главнее HARNAS_*: новый адрес перекрывает старый', async () => {
    const workDir = await legacyProject();
    await updateMap(project, workId, (map) => {
      addSession(map, { provider: 'claude', label: 'тесты', task: 'написать тесты' });
    });

    const context = contextFromEnv({ ...savedEnv(workDir), PARLEY_SESSION_ID: 's-02' });

    expect(context.sessionId).toBe('s-02');
    expect(context.workDir).toBe(workDir);
  });

  it('каталог не из раскладки работы отвергается под любым именем переменной, с подсказкой про оба каталога', () => {
    expect(() => contextFromEnv({ HARNAS_WORK_DIR: project })).toThrow(/HARNAS_WORK_DIR=.*\.parley\/works.*\.harnas\/works/);
    expect(() => contextFromEnv({ PARLEY_WORK_DIR: project })).toThrow(/PARLEY_WORK_DIR=/);
    expect(() => contextFromEnv({ PARLEY_WORK_DIR: path.join(project, 'other', 'works', 'w-0001') })).toThrow(
      /does not look like/,
    );
  });

  it('новый .parley принимается так же: оба базовых имени годятся', () => {
    const newDir = path.join(project, '.parley', 'works', 'w-0007');
    expect(contextFromEnv({ PARLEY_WORK_DIR: newDir })).toMatchObject({ projectPath: project, workId: 'w-0007' });
    const oldDir = path.join(project, '.harnas', 'works', 'w-0007');
    expect(contextFromEnv({ HARNAS_WORK_DIR: oldDir })).toMatchObject({ projectPath: project, workId: 'w-0007' });
  });

  it('новый конфиг сессии несёт оба набора: сохранённый им файл читается и старой, и новой сборкой', async () => {
    const workDir = await legacyProject();
    const json = JSON.parse(mcpConfigJson({ workDir, sessionId: 's-01', channel: true })) as {
      mcpServers: Record<string, { env: Record<string, string> }>;
    };
    const env = Object.values(json.mcpServers)[0]?.env ?? {};

    // Только прежние имена из нового файла — то, что прочитала бы старая сборка.
    const oldOnly = Object.fromEntries(Object.entries(env).filter(([name]) => name.startsWith('HARNAS_')));
    // Только новые — то, что прочитает новая.
    const newOnly = Object.fromEntries(Object.entries(env).filter(([name]) => name.startsWith('PARLEY_')));
    expect(contextFromEnv(oldOnly)).toEqual(contextFromEnv(newOnly));
    expect(contextFromEnv(newOnly)).toMatchObject({ projectPath: project, workId, sessionId: 's-01', channel: true });
  });
});
