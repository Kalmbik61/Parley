import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as core from '@parley/core';
import { createWork, HUMAN, updateMap, readStoredMap } from '@parley/core';
import { connectRaw, hello, holdDatabase, removeHome, tempHome, waitConnected } from '../../test/helpers.js';
import type { RawMessage, TestClient } from '../../test/helpers.js';
import { startHost } from '../host.js';
import type { RunningHost } from '../host.js';
import { hostPaths } from '../paths.js';
import type { RequestInfo } from '../context.js';
import { mailMarkRead } from './mail.js';

let hosts: RunningHost[] = [];
let homes: string[] = [];
let projects: string[] = [];

afterEach(async () => {
  await Promise.all(hosts.map((h) => h.context.shutdown('test-cleanup').catch(() => {})));
  hosts = [];
  await Promise.all(homes.map((home) => removeHome(home)));
  homes = [];
  await Promise.all(projects.map((dir) => rm(dir, { recursive: true, force: true })));
  projects = [];
});

/** Ответ на запрос `id`: события `works.changed` и прочие рассылки между ними пропускаются. */
async function reply(client: TestClient, id: number): Promise<RawMessage> {
  for (;;) {
    const message = await client.next();
    if (message.id === id) return message;
  }
}

/** Хост, клиент и работа с одним письмом агента человеку (m-01). */
async function withLetter(): Promise<{ client: TestClient; dir: string; workId: string; home: string }> {
  const home = await tempHome();
  homes.push(home);
  const running = await startHost({ home });
  hosts.push(running);
  const token = await readFile(hostPaths(home).token, 'utf8');
  const dir = await mkdtemp(path.join(tmpdir(), 'parley-mail-project-'));
  projects.push(dir);

  const client = connectRaw(hostPaths(home).socket);
  await waitConnected(client.socket);
  await hello(client, token);
  client.send({ id: 1, method: 'works.create', params: { projectPath: dir, title: 'Почта', goal: '' } });
  const workId = ((await reply(client, 1)).result as { workId: string }).workId;
  await updateMap(dir, workId, (map, letters) => {
    letters.add({ roomId: null, kind: 'note', from: 's-01', to: [HUMAN], text: 'вопрос' });
  });
  return { client, dir, workId, home };
}

describe('mail.markRead', () => {
  it('отмечает письмо человеку прочитанным, повтор — { marked: 0 }', async () => {
    const { client, dir, workId } = await withLetter();

    client.send({ id: 2, method: 'mail.markRead', params: { projectPath: dir, workId, messageIds: ['m-01'] } });
    expect((await reply(client, 2)).result).toEqual({ marked: 1 });
    expect((readStoredMap(dir, workId)).messages[0]?.readBy[HUMAN]).toBeDefined();

    client.send({ id: 3, method: 'mail.markRead', params: { projectPath: dir, workId, messageIds: ['m-01'] } });
    expect((await reply(client, 3)).result).toEqual({ marked: 0 });
    client.close();
  });

  it('несуществующая работа — not_found, а не internal', async () => {
    const { client, dir } = await withLetter();

    client.send({
      id: 2,
      method: 'mail.markRead',
      params: { projectPath: dir, workId: 'w-9999', messageIds: ['m-01'] },
    });
    expect((await reply(client, 2)).error?.code).toBe('not_found');
    client.close();
  });

  // База занята заранее другим процессом, который внутри захвата снимает работу: запись гарантированно
  // встаёт в ожидание уже после проверки работы и чтения карты, — иначе гонку почти всегда выигрывает not_found.
  it('работа удалена, пока запись ждала базу — not_found, хост жив', async () => {
    const { client, dir, workId, home } = await withLetter();
    const held = await holdDatabase(home, 300, { projectPath: dir, workId });

    client.send({ id: 2, method: 'mail.markRead', params: { projectPath: dir, workId, messageIds: ['m-01'] } });

    expect((await reply(client, 2)).error?.code).toBe('not_found');
    await held.done;
    client.send({ id: 3, method: 'works.list', params: {} });
    expect((await reply(client, 3)).result).toBeDefined();
    client.close();
  });

  it('501 id — bad_request на схеме, карта не тронута', async () => {
    const { client, dir, workId } = await withLetter();
    const messageIds = Array.from({ length: 501 }, (_, i) => `m-${i + 1}`);

    client.send({ id: 2, method: 'mail.markRead', params: { projectPath: dir, workId, messageIds } });
    expect((await reply(client, 2)).error?.code).toBe('bad_request');
    expect((readStoredMap(dir, workId)).messages[0]?.readBy[HUMAN]).toBeUndefined();
    client.close();
  });
});

describe('mail.markRead: карта целиком не читается', () => {
  // Спека хранилища 6.2: проверка работы и отметка — запросами к базе; `readMap` копирует всю карту работы.
  it('отметка не зовёт readMap; повтор и несуществующая работа — прежние ответы', async () => {
    const home = await tempHome();
    homes.push(home);
    const previous = process.env.PARLEY_HOME;
    process.env.PARLEY_HOME = home;
    const dir = await mkdtemp(path.join(tmpdir(), 'parley-mail-project-'));
    projects.push(dir);
    const request = {} as RequestInfo;
    try {
      const workId = (await createWork(dir, { title: 'Почта' })).work.id;
      await updateMap(dir, workId, (_map, letters) => {
        letters.add({ roomId: null, from: 's-01', to: [HUMAN], text: 'вопрос', kind: 'note' });
      });
      const params = { projectPath: dir, workId, messageIds: ['m-01'] };
      const readMapSpy = vi.spyOn(core, 'readMap');
      try {
        expect(await mailMarkRead(params, request)).toEqual({ marked: 1 });
        expect(await mailMarkRead(params, request)).toEqual({ marked: 0 });
        await expect(mailMarkRead({ ...params, workId: 'w-9999' }, request)).rejects.toMatchObject({ code: 'not_found' });
        expect(readMapSpy).not.toHaveBeenCalled();
      } finally {
        readMapSpy.mockRestore();
      }
      expect((readStoredMap(dir, workId)).messages[0]?.readBy[HUMAN]).toBeDefined();
    } finally {
      if (previous === undefined) delete process.env.PARLEY_HOME;
      else process.env.PARLEY_HOME = previous;
    }
  });
});
