import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HUMAN, addMessage, addRoom, addSession, createWork, transitionSession, flushDecisionJournal, resolveProposal, setProposal, suggestBacklog, updateMap, workPaths,
} from '@parley/core';
import { COMPACT_WORKS_FEATURE } from '@parley/protocol';
import type { WorksSnapshot } from '@parley/protocol';
import { connectRaw, hello, removeHome, tempHome, waitConnected } from '../../test/helpers.js';
import type { RawMessage, TestClient } from '../../test/helpers.js';
import { startHost } from '../host.js';
import type { RunningHost } from '../host.js';
import { hostPaths } from '../paths.js';

/**
 * Панели окна после миграции карты при старте хоста (план карты-журнала, задача 10): хост с включённой миграцией
 * переводит работу без живых сессий на журналы, а решения, бэклог, история комнаты и страницы переписки отвечают то же,
 * что отвечали на карте v2. Проверка на уровне методов хоста, не экрана.
 */
let hosts: RunningHost[] = [];
let homes: string[] = [];
let projects: string[] = [];
let nextId = 1;

afterEach(async () => {
  await Promise.all(hosts.map((host) => host.context.shutdown('test-cleanup').catch(() => {})));
  hosts = [];
  delete process.env.PARLEY_HOME;
  await Promise.all(homes.map((home) => removeHome(home)));
  homes = [];
  await Promise.all(projects.map((dir) => rm(dir, { recursive: true, force: true })));
  projects = [];
});

async function ask(client: TestClient, method: string, params: unknown): Promise<RawMessage> {
  const id = nextId;
  nextId += 1;
  client.send({ id, method, params });
  for (;;) {
    const message = await client.next();
    if (message.id === id) return message;
  }
}

/** Ответы панелей одним списком: по нему сравниваются хост до миграции и после. */
async function panels(home: string, dir: string, workId: string): Promise<Record<string, unknown>> {
  const token = await readFile(hostPaths(home).token, 'utf8');
  const client = connectRaw(hostPaths(home).socket);
  await waitConnected(client.socket);
  await hello(client, token, { features: [COMPACT_WORKS_FEATURE] });
  const room = { projectPath: dir, workId, roomId: 'r-01' };
  const decisions = (await ask(client, 'decisions.list', { projectPath: dir })).result as { decisions: unknown[] };
  const backlog = (await ask(client, 'backlog.get', { projectPath: dir })).result as { suggestions: Array<{ title: string; author?: { label: string; sessionId: string } }> };
  const pages = (await ask(client, 'context.messages', { ...room })).result as { messages: Array<{ id: string; text: string }> };
  const answers = {
    decisions,
    suggestions: backlog.suggestions.map((row) => [row.title, row.author?.label, row.author?.sessionId]),
    history: (await ask(client, 'rooms.history.get', room)).result,
    messages: pages.messages.map((row) => [row.id, row.text]),
    text: (await ask(client, 'context.text', { projectPath: dir, workId, ref: { kind: 'message', id: pages.messages[0]!.id } })).result,
  };
  client.close();
  return answers;
}

const schemaOnDisk = async (dir: string, workId: string): Promise<number> =>
  (JSON.parse(await readFile(workPaths(dir, workId).map, 'utf8')) as { schemaVersion: number }).schemaVersion;

describe('панели окна на мигрированной карте', () => {
  it('хост с включённой миграцией переводит работу на v3, и панели показывают то же, что показывали на v2', async () => {
    const home = await tempHome();
    homes.push(home);
    process.env.PARLEY_HOME = home;
    const dir = await mkdtemp(path.join(tmpdir(), 'parley-panels-project-'));
    projects.push(dir);
    const workId = (await createWork(dir, { title: 'Работа', goal: 'Цель' })).work.id;
    await updateMap(dir, workId, (map) => {
      addSession(map, { provider: 'claude', label: 'Ведущий', task: 'x' });
      addRoom(map, { title: 'Комната', creator: HUMAN, members: ['s-01'], lead: 's-01' });
      addMessage(map, { from: 's-01', to: [], roomId: 'r-01', text: 'первое письмо' });
      addMessage(map, { from: HUMAN, to: [], roomId: 'r-01', text: 'второе письмо' });
      const proposal = setProposal(map, 'r-01', 's-01', 'Решили так\nпотому что просто', new Date().toISOString());
      resolveProposal(map, 'r-01', proposal.proposalId, 'accept', { rev: proposal.rev });
    });
    await flushDecisionJournal(dir, workId);
    await suggestBacklog(dir, { kind: 'idea', title: 'Идея', why: 'Стоит', workId, sessionId: 's-01' });
    expect(await schemaOnDisk(dir, workId)).toBe(2);

    // Хост без миграции: панели на v2.
    const plain = await startHost({ home });
    hosts.push(plain);
    const before = await panels(home, dir, workId);
    expect(await schemaOnDisk(dir, workId)).toBe(2);
    expect((before.decisions as { decisions: unknown[] }).decisions).toHaveLength(1);
    await plain.context.shutdown('test-restart');
    await plain.closed;

    // Тот же дом, миграция включена, живых сессий нет.
    const migrating = await startHost({ home, migrateMaps: true });
    hosts.push(migrating);
    // Миграция идёт после первого снимка, не внутри старта: ждём её по диску.
    await vi.waitFor(async () => expect(await schemaOnDisk(dir, workId)).toBe(3), { timeout: 10_000, interval: 20 });
    expect(await panels(home, dir, workId)).toEqual(before);
  }, 30_000);
});

/** Работа на v2 с сессией и двумя письмами; `live` — сессия активна, её pid — этот процесс (хост видит живую сессию). */
async function seedWork(dir: string, live: boolean): Promise<string> {
  const { work } = await createWork(dir, { title: 'Работа', goal: 'Цель' });
  await updateMap(dir, work.id, (map) => {
    const session = addSession(map, { provider: 'claude', label: 'a', task: 't' });
    if (live) {
      session.pid = process.pid;
      transitionSession(map, session.id, 'active');
    }
    addMessage(map, { roomId: null, from: HUMAN, to: [session.id], text: 'первое' });
    addMessage(map, { roomId: null, from: HUMAN, to: [session.id], text: 'второе' });
  });
  return work.id;
}

async function freshHome(): Promise<{ home: string; dir: string }> {
  const home = await tempHome();
  homes.push(home);
  process.env.PARLEY_HOME = home;
  const dir = await mkdtemp(path.join(tmpdir(), 'parley-migrate-project-'));
  projects.push(dir);
  return { home, dir };
}

async function startMigrating(home: string): Promise<RunningHost> {
  const host = await startHost({ home, migrateMaps: true });
  hosts.push(host);
  return host;
}

const exists = (file: string): Promise<boolean> => stat(file).then(() => true, () => false);

async function windowEntries(home: string): Promise<WorksSnapshot['entries']> {
  const token = await readFile(hostPaths(home).token, 'utf8');
  const client = connectRaw(hostPaths(home).socket);
  await waitConnected(client.socket);
  await hello(client, token, { features: [COMPACT_WORKS_FEATURE] });
  const entries = ((await ask(client, 'works.list', {})).result as WorksSnapshot).entries;
  client.close();
  return entries;
}

describe('включение миграции в хосте', () => {
  it('работа с живой сессией остаётся на v2 и в снимке окна помечена migrationPending; соседняя без сессий переведена', async () => {
    const { home, dir } = await freshHome();
    const live = await seedWork(dir, true);
    const idle = await seedWork(dir, false);

    await startMigrating(home);
    await vi.waitFor(async () => expect(await schemaOnDisk(dir, idle)).toBe(3), { timeout: 10_000, interval: 20 });

    expect(await schemaOnDisk(dir, live)).toBe(2);
    expect(await exists(path.join(workPaths(dir, live).dir, 'map.v2.json'))).toBe(false);
    const entries = await windowEntries(home);
    expect(entries.find((entry) => entry.map.work.id === live)?.migrationPending).toBe(true);
    expect(entries.find((entry) => entry.map.work.id === idle)?.migrationPending).toBeUndefined();
  }, 30_000);

  it('сбой перевода одной работы (на месте копии v2 лежит каталог) не мешает переводу другой', async () => {
    const { home, dir } = await freshHome();
    const broken = await seedWork(dir, false);
    const fine = await seedWork(dir, false);
    await mkdir(path.join(workPaths(dir, broken).dir, 'map.v2.json'));

    await startMigrating(home);
    await vi.waitFor(async () => expect(await schemaOnDisk(dir, fine)).toBe(3), { timeout: 10_000, interval: 20 });

    expect(await schemaOnDisk(dir, broken)).toBe(2);
    const entries = await windowEntries(home);
    expect(entries.find((entry) => entry.map.work.id === broken)?.map.messages).toHaveLength(2);
  }, 30_000);

  it('две работы за один проход переводятся обе, копия v2 остаётся на весь запуск и убирается ВТОРЫМ запуском хоста', async () => {
    const { home, dir } = await freshHome();
    const first = await seedWork(dir, false);
    const second = await seedWork(dir, false);

    const run1 = await startMigrating(home);
    for (const id of [first, second]) await vi.waitFor(async () => expect(await schemaOnDisk(dir, id)).toBe(3), { timeout: 10_000, interval: 20 });
    for (const id of [first, second]) expect(await exists(path.join(workPaths(dir, id).dir, 'map.v2.json'))).toBe(true);
    await run1.context.shutdown('test-restart');
    await run1.closed;

    await startMigrating(home);
    for (const id of [first, second]) {
      await vi.waitFor(async () => expect(await exists(path.join(workPaths(dir, id).dir, 'map.v2.json'))).toBe(false), { timeout: 10_000, interval: 20 });
    }
    const entries = await windowEntries(home);
    expect(entries.map((entry) => entry.map.messages.length)).toEqual([2, 2]);
  }, 30_000);
});
