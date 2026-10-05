import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addMessage, addRoom, addSession, createWork, updateMap } from '@parley/core';
import type { Message } from '@parley/core';
import { COMPACT_WORKS_FEATURE, HOST_ERROR_REASONS, MAX_LINE_BYTES } from '@parley/protocol';
import type { WorksSnapshot } from '@parley/protocol';
import { connectRaw, hello, removeHome, tempHome, waitConnected } from '../../test/helpers.js';
import type { RawMessage, TestClient } from '../../test/helpers.js';
import { startHost } from '../host.js';
import type { RunningHost } from '../host.js';
import { hostPaths } from '../paths.js';

let hosts: RunningHost[] = [];
let homes: string[] = [];
let projects: string[] = [];

/**
 * Дом и работы готовятся до старта хоста: тогда первое чтение хоста уже видит работы, и снимок не надо ждать.
 * `PARLEY_HOME` на время подготовки указывает на дом теста — настоящий дом пользователя не трогается.
 */
async function bootWith<T>(prepare: (dir: string) => Promise<T>): Promise<{ home: string; token: string; dir: string; prepared: T }> {
  const home = await tempHome();
  homes.push(home);
  process.env.PARLEY_HOME = home;
  const dir = await project();
  const prepared = await prepare(dir);
  hosts.push(await startHost({ home }));
  return { home, token: await readFile(hostPaths(home).token, 'utf8'), dir, prepared };
}

async function project(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'parley-pages-project-'));
  projects.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(hosts.map((host) => host.context.shutdown('test-cleanup').catch(() => {})));
  hosts = [];
  delete process.env.PARLEY_HOME;
  await Promise.all(homes.map((home) => removeHome(home)));
  homes = [];
  await Promise.all(projects.map((dir) => rm(dir, { recursive: true, force: true })));
  projects = [];
});

let nextId = 1000;

/** Запрос с ожиданием своего ответа: события `works.changed` между ними пропускаются. */
async function ask(client: TestClient, method: string, params: unknown): Promise<RawMessage> {
  const id = nextId;
  nextId += 1;
  client.send({ id, method, params });
  for (;;) {
    const message = await client.next();
    if (message.id === id) return message;
  }
}

async function connect(home: string, token: string, features?: string[]): Promise<{ client: TestClient; hello: RawMessage }> {
  const client = connectRaw(hostPaths(home).socket);
  await waitConnected(client.socket);
  const answer = await hello(client, token, features === undefined ? {} : { features });
  return { client, hello: answer };
}

/** Работа с комнатой и перепиской. */
async function seed(dir: string, count: number, size: number, extra: Partial<Parameters<typeof addMessage>[1]> = {}): Promise<string> {
  const map = await createWork(dir, { title: 'Работа', goal: 'Цель работы' });
  await updateMap(dir, map.work.id, (current) => {
    addSession(current, { provider: 'claude', label: 'план', task: 'x' });
    addSession(current, { provider: 'claude', label: 'код', task: 'y', parent: 's-01' });
    addRoom(current, { title: 'Комната', creator: 'human', members: ['s-01', 's-02'], lead: 's-01' });
    for (let i = 0; i < count; i += 1) addMessage(current, { from: 's-02', to: [], roomId: 'r-01', text: `${i}:`.padEnd(size, 'я'), ...extra });
  });
  return map.work.id;
}

const append = async (dir: string, workId: string, count: number): Promise<void> => {
  await updateMap(dir, workId, (current) => {
    for (let i = 0; i < count; i += 1) addMessage(current, { from: 's-02', to: [], roomId: 'r-01', text: `новое ${i}` });
  });
};

describe('hello и снимок работ: возможность compact-works', () => {
  it('хост называет свои возможности; окно с возможностью получает компактный снимок с номером, без неё — полный', async () => {
    const { home, token, prepared: workId } = await bootWith((dir) => seed(dir, 300, 400));

    const compact = await connect(home, token, [COMPACT_WORKS_FEATURE]);
    expect((compact.hello.result as { features?: string[] }).features).toContain(COMPACT_WORKS_FEATURE);
    const legacy = await connect(home, token);

    const fresh = (await ask(compact.client, 'works.list', {})).result as WorksSnapshot;
    const map = fresh.entries.find((entry) => entry.map.work.id === workId)?.map;
    expect(map?.messages.length).toBeLessThan(300);
    expect(map?.compact?.messages).toMatchObject({ total: 300, latestId: 'm-300' });
    expect(typeof fresh.revision).toBe('number');

    const full = (await ask(legacy.client, 'works.list', {})).result as WorksSnapshot;
    expect(full.entries.find((entry) => entry.map.work.id === workId)?.map.messages).toHaveLength(300);
    compact.client.close();
    legacy.client.close();
  });

  it('воспроизведение 1 (900 писем по 10 000 знаков): окно с возможностью читает снимок и остаётся на связи; прежнее окно — ошибка с просьбой обновить, не обрыв', async () => {
    const { home, token } = await bootWith((dir) => seed(dir, 900, 10_000));

    const compact = await connect(home, token, [COMPACT_WORKS_FEATURE]);
    const answer = await ask(compact.client, 'works.list', {});
    expect(answer.error).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(answer))).toBeLessThan(MAX_LINE_BYTES / 4);
    // Связь жива: следующий запрос отвечает.
    expect((await ask(compact.client, 'host.info', {})).result).toMatchObject({ clients: expect.any(Number) });

    const legacy = await connect(home, token);
    const refused = await ask(legacy.client, 'works.list', {});
    expect(refused.error).toMatchObject({ code: 'conflict', data: { reason: HOST_ERROR_REASONS.clientUpgradeRequired } });
    expect(refused.error?.message).toMatch(/update/i);
    expect(legacy.client.socket.destroyed).toBe(false);
    expect((await ask(legacy.client, 'host.info', {})).result).toBeDefined();
    compact.client.close();
    legacy.client.close();
  });

  it('воспроизведение 2 (2 100 решений по 4 000 знаков) и 10 тыс. писем в нескольких работах: компактный снимок входит в кадр', async () => {
    const { home, token } = await bootWith(async (dir) => {
      await seed(dir, 2100, 4000, { kind: 'decision' });
      for (let i = 0; i < 3; i += 1) await seed(dir, 2500, 1500);
    });
    const compact = await connect(home, token, [COMPACT_WORKS_FEATURE]);
    const answer = await ask(compact.client, 'works.list', {});
    expect(answer.error).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(answer))).toBeLessThan(5 * 1024 * 1024);
    const snapshot = answer.result as WorksSnapshot;
    expect(snapshot.entries).toHaveLength(4);
    expect(snapshot.entries.map((entry) => entry.map.compact?.messages.total).sort()).toEqual([2100, 2500, 2500, 2500]);
    compact.client.close();
  }, 60_000);
});

describe('context.messages', () => {
  it('страницы идут от новых к старым до конца без повторов, даже когда комната пишется между запросами', async () => {
    const { home, token, dir, prepared: workId } = await bootWith((dir) => seed(dir, 200, 1500));
    const { client } = await connect(home, token, [COMPACT_WORKS_FEATURE]);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 200; guard += 1) {
      const answer = await ask(client, 'context.messages', { projectPath: dir, workId, roomId: 'r-01', maxBytes: 16384, ...(cursor === undefined ? {} : { cursor }) });
      expect(answer.error).toBeUndefined();
      const { messages, page } = answer.result as { messages: Message[]; page: { complete: boolean; next: string | null; total: number; bytes: number } };
      expect(page.bytes).toBeLessThanOrEqual(16384);
      seen.unshift(...messages.map((message) => message.id));
      await append(dir, workId, 2); // комната живёт, пока окно листает историю
      if (page.complete) break;
      cursor = page.next as string;
    }
    expect(seen).toHaveLength(200);
    expect(seen[0]).toBe('m-01');
    expect(seen.at(-1)).toBe('m-200');
    expect(new Set(seen).size).toBe(200);

    // Дописанное забирается курсором after без повторов и пропусков.
    const newer = await ask(client, 'context.messages', { projectPath: dir, workId, roomId: 'r-01', cursor: 'after:200' });
    const rows = (newer.result as { messages: Message[] }).messages;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((message) => message.id)).toEqual(Array.from({ length: rows.length }, (_, index) => `m-${201 + index}`));
    client.close();
  });

  it('прямые письма (roomId null), неизвестная работа и комната, кривой курсор — понятные отказы', async () => {
    const { home, token, dir, prepared: workId } = await bootWith(async (dir) => {
      const id = await seed(dir, 3, 20);
      await updateMap(dir, id, (current) => { addMessage(current, { from: 's-01', to: ['s-02'], text: 'прямое' }); });
      return id;
    });
    const { client } = await connect(home, token, [COMPACT_WORKS_FEATURE]);

    const direct = await ask(client, 'context.messages', { projectPath: dir, workId, roomId: null });
    expect((direct.result as { messages: Message[] }).messages.map((message) => message.text)).toEqual(['прямое']);
    expect((await ask(client, 'context.messages', { projectPath: dir, workId: 'w-9999', roomId: null })).error?.code).toBe('not_found');
    expect((await ask(client, 'context.messages', { projectPath: dir, workId, roomId: 'r-77' })).error?.code).toBe('not_found');
    expect((await ask(client, 'context.messages', { projectPath: dir, workId, roomId: 'r-01', cursor: 'sideways' })).error?.code).toBe('bad_request');
    client.close();
  });

  it('письмо длиннее страницы сокращено и называет полный размер; context.text отдаёт его целиком кусками', async () => {
    // ASCII: сырой тестовый клиент декодирует каждый кусок сокета отдельно и рвёт многобайтовые знаки на стыках.
    const long = 'x'.repeat(200_000);
    const { home, token, dir, prepared: workId } = await bootWith(async (dir) => {
      const id = await seed(dir, 0, 0);
      await updateMap(dir, id, (current) => { addMessage(current, { from: 's-02', to: [], roomId: 'r-01', text: long }); });
      return id;
    });
    const { client } = await connect(home, token, [COMPACT_WORKS_FEATURE]);

    const page = await ask(client, 'context.messages', { projectPath: dir, workId, roomId: 'r-01', maxBytes: 8192 });
    const result = page.result as { messages: Message[]; page: { cut: number } };
    expect(result.page.cut).toBe(1);
    expect(result.messages[0]?.textBytes).toBe(200_000);

    let text = '';
    let cursor: string | undefined;
    for (let guard = 0; guard < 100; guard += 1) {
      const answer = await ask(client, 'context.text', { projectPath: dir, workId, ref: { kind: 'message', id: 'm-01' }, maxBytes: 65536, ...(cursor === undefined ? {} : { cursor }) });
      const chunk = answer.result as { text: string; complete: boolean; next: string | null; totalBytes: number };
      expect(chunk.totalBytes).toBe(200_000);
      text += chunk.text;
      if (chunk.complete) break;
      cursor = chunk.next as string;
    }
    expect(text).toBe(long);
    client.close();
  });

  it('context.text: цель и поля сессии; несуществующее — not_found; текст сменился — bad_request со stale-cursor', async () => {
    const { home, token, dir, prepared: workId } = await bootWith(async (dir) => {
      const id = await seed(dir, 0, 0);
      await updateMap(dir, id, (current) => {
        current.sessions[0]!.task = 'z'.repeat(9000);
        current.sessions[0]!.summary = 'итог';
      });
      return id;
    });
    const { client } = await connect(home, token, [COMPACT_WORKS_FEATURE]);
    expect((await ask(client, 'context.text', { projectPath: dir, workId, ref: { kind: 'goal' } })).result).toMatchObject({ complete: true });
    expect((await ask(client, 'context.text', { projectPath: dir, workId, ref: { kind: 'session', sessionId: 's-01', field: 'summary' } })).result).toMatchObject({ complete: true });
    expect((await ask(client, 'context.text', { projectPath: dir, workId, ref: { kind: 'session', sessionId: 's-09', field: 'task' } })).error?.code).toBe('not_found');
    expect((await ask(client, 'context.text', { projectPath: dir, workId, ref: { kind: 'message', id: 'm-99' } })).error?.code).toBe('not_found');

    const first = await ask(client, 'context.text', { projectPath: dir, workId, ref: { kind: 'session', sessionId: 's-01', field: 'task' }, maxBytes: 2048 });
    const next = (first.result as { next: string }).next;
    await updateMap(dir, workId, (current) => { current.sessions[0]!.task = 'другая задача'; });
    const stale = await ask(client, 'context.text', { projectPath: dir, workId, ref: { kind: 'session', sessionId: 's-01', field: 'task' }, cursor: next });
    expect(stale.error).toMatchObject({ code: 'bad_request', data: { reason: 'stale-cursor' } });
    client.close();
  });
});
