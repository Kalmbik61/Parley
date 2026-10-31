import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addSession, setResult } from '../work/map.js';
import { addRoom } from '../work/rooms.js';
import { createWork, readMap, setWorkCloseFinished, updateMap, workPaths } from '../work/store.js';
import { HUMAN } from '../work/types.js';
import { createParleyServer } from './tools.js';

let home = '';
let project = '';
let workId = '';
const opened: { client: Client; server: ReturnType<typeof createParleyServer> }[] = [];

async function connect(sessionId: string): Promise<Client> {
  const server = createParleyServer({
    projectPath: project,
    workId,
    workDir: workPaths(project, workId).dir,
    sessionId,
    pollMs: 40,
    channel: false,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  opened.push({ client, server });
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text?: string }[];
  return { isError: result.isError === true, text: content[0]?.text ?? '' };
}

const DENIED = 'close_session can only close the calling session, a session it created, or — when the workspace lets agents close finished sessions — a finished member of the room it leads (s-02 is not one of them)';

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
  process.env.PARLEY_HOME = home;
  workId = (await createWork(project, { title: 'Работа', goal: 'цель' })).work.id;
});

afterEach(async () => {
  for (const { client, server } of opened.splice(0)) {
    await client.close();
    await server.close();
  }
  delete process.env.PARLEY_HOME;
  await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('close_session: право живого лида закрыть завершившего участника комнаты', () => {
  interface Cell {
    flag: boolean;
    lead: boolean;
    inRoom: boolean;
    done: boolean;
    swarm: boolean;
  }

  /** s-01 — вызывающий, s-02 — цель, s-03 — второй участник; ни одну из них s-01 не создавал. */
  async function seed(cell: Cell): Promise<void> {
    await updateMap(project, workId, (map) => {
      for (const label of ['вызывающий', 'цель', 'другой']) addSession(map, { provider: 'claude', label, task: 'x' });
      addRoom(map, {
        title: 'Комната',
        creator: HUMAN,
        members: cell.inRoom ? ['s-01', 's-02', 's-03'] : ['s-01', 's-03'],
        lead: cell.lead ? 's-01' : 's-03',
      });
      if (cell.done) setResult(map, 's-02', 'done');
      if (cell.swarm) {
        map.swarms = [{
          id: 'sw-01', tag: 'T', creator: { kind: 'human' }, objective: 'o', queen: 's-02',
          members: [{ sessionId: 's-02', role: 'queen', n: 1, addedAt: new Date().toISOString(), handedAt: null }],
          status: 'running', createdAt: new Date().toISOString(), endedAt: null, expiredAt: null, result: null, failure: null, seenAt: null,
        }];
      }
    });
    if (cell.flag) await setWorkCloseFinished(project, workId, true);
  }

  const bools = [true, false];
  const cells: Cell[] = bools.flatMap((flag) => bools.flatMap((lead) => bools.flatMap((inRoom) =>
    bools.flatMap((done) => bools.map((swarm) => ({ flag, lead, inRoom, done, swarm }))))));

  it.each(cells)('флаг=$flag лид=$lead в комнате=$inRoom итог done=$done рой=$swarm', async (cell) => {
    await seed(cell);
    const allowed = cell.flag && cell.lead && cell.inRoom && cell.done && !cell.swarm;

    const result = await call(await connect('s-01'), 'close_session', { target: 's-02' });

    const lifecycle = (await readMap(project, workId)).sessions.find((row) => row.id === 's-02')?.lifecycle;
    if (allowed) {
      expect(result.isError, result.text).toBe(false);
      expect(lifecycle).toBe('closed');
    } else {
      expect(result.isError).toBe(true);
      // Участнику роя отказ прежний и проверяется первым, остальным — новый текст.
      if (cell.swarm) expect(result.text).toContain('close_session cannot close s-02: it is a swarm member; only the human cancels a swarm');
      else expect(result.text).toContain(DENIED);
      expect(lifecycle).not.toBe('closed');
    }
  });

  it('число клеток, где закрытие проходит, — ровно одна из тридцати двух', () => {
    expect(cells.filter((cell) => cell.flag && cell.lead && cell.inRoom && cell.done && !cell.swarm)).toHaveLength(1);
    expect(cells).toHaveLength(32);
  });

  it('лид архивной комнаты не закрывает её завершившего участника', async () => {
    await seed({ flag: true, lead: true, inRoom: true, done: true, swarm: false });
    await updateMap(project, workId, (map) => {
      const room = map.rooms[0];
      if (room) room.archivedAt = new Date().toISOString();
    });

    const result = await call(await connect('s-01'), 'close_session', { target: 's-02' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain(DENIED);
    expect((await readMap(project, workId)).sessions.find((row) => row.id === 's-02')?.lifecycle).not.toBe('closed');
  });

  it.each([true, false])('себя и созданную собой сессию можно закрыть при флаге=%s', async (flag) => {
    await updateMap(project, workId, (map) => {
      addSession(map, { provider: 'claude', label: 'вызывающий', task: 'x' });
      addSession(map, { provider: 'claude', label: 'дитя', task: 'x', createdBy: 's-01' });
    });
    if (flag) await setWorkCloseFinished(project, workId, true);
    const client = await connect('s-01');

    expect((await call(client, 'close_session', { target: 's-02' })).isError).toBe(false);
    expect((await call(client, 'close_session', { target: 's-01' })).isError).toBe(false);

    const map = await readMap(project, workId);
    expect(map.sessions.map((row) => row.lifecycle)).toEqual(['closed', 'closed']);
  });

  it('get_map показывает work.closeFinished только при включённом флаге', async () => {
    await updateMap(project, workId, (map) => {
      addSession(map, { provider: 'claude', label: 'вызывающий', task: 'x' });
    });
    const client = await connect('s-01');
    const work = async (): Promise<Record<string, unknown>> =>
      (JSON.parse((await call(client, 'get_map', {})).text) as { map: { work: Record<string, unknown> } }).map.work;

    expect(await work()).not.toHaveProperty('closeFinished');
    await setWorkCloseFinished(project, workId, true);
    expect((await work())['closeFinished']).toBe(true);
    await setWorkCloseFinished(project, workId, false);
    expect(await work()).not.toHaveProperty('closeFinished');
  });
});
