import { mkdtemp, open, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addMessage, HUMAN, readMap, updateMap, workPaths } from '@harnas/core';
import { connectRaw, hello, removeHome, tempHome, waitConnected } from '../../test/helpers.js';
import type { RawMessage, TestClient } from '../../test/helpers.js';
import { startHost } from '../host.js';
import type { RunningHost } from '../host.js';
import { hostPaths } from '../paths.js';

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
async function withLetter(): Promise<{ client: TestClient; dir: string; workId: string }> {
  const home = await tempHome();
  homes.push(home);
  const running = await startHost({ home });
  hosts.push(running);
  const token = await readFile(hostPaths(home).token, 'utf8');
  const dir = await mkdtemp(path.join(tmpdir(), 'harnas-mail-project-'));
  projects.push(dir);

  const client = connectRaw(hostPaths(home).socket);
  await waitConnected(client.socket);
  await hello(client, token);
  client.send({ id: 1, method: 'works.create', params: { projectPath: dir, title: 'Почта', goal: '' } });
  const workId = ((await reply(client, 1)).result as { workId: string }).workId;
  await updateMap(dir, workId, (map) => {
    addMessage(map, { from: 's-01', to: [HUMAN], text: 'вопрос' });
  });
  return { client, dir, workId };
}

describe('mail.markRead', () => {
  it('отмечает письмо человеку прочитанным, повтор — { marked: 0 }', async () => {
    const { client, dir, workId } = await withLetter();

    client.send({ id: 2, method: 'mail.markRead', params: { projectPath: dir, workId, messageIds: ['m-01'] } });
    expect((await reply(client, 2)).result).toEqual({ marked: 1 });
    expect((await readMap(dir, workId)).messages[0]?.readBy[HUMAN]).toBeDefined();

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

  // Лок карты занят заранее, чтобы запись гарантированно встала в ожидание уже после
  // проверки работы и чтения карты, — иначе гонку почти всегда выигрывает not_found.
  // Файл лока остаётся и после close: писатель ждёт, пока каталог не пропадёт.
  it('работа удалена, пока запись ждала map.lock — not_found, хост жив', async () => {
    const { client, dir, workId } = await withLetter();
    const paths = workPaths(dir, workId);
    const held = await open(paths.lock, 'wx');

    client.send({ id: 2, method: 'mail.markRead', params: { projectPath: dir, workId, messageIds: ['m-01'] } });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await held.close();
    // Каталог уносится одним rename, а не rm: ожидающий писатель мог бы создать лок в
    // каталоге посреди рекурсивного удаления, и rm упал бы с ENOTEMPTY.
    await rename(paths.dir, path.join(dir, 'gone-work'));

    expect((await reply(client, 2)).error?.code).toBe('not_found');
    client.send({ id: 3, method: 'works.list', params: {} });
    expect((await reply(client, 3)).result).toBeDefined();
    client.close();
  });

  it('501 id — bad_request на схеме, карта не тронута', async () => {
    const { client, dir, workId } = await withLetter();
    const messageIds = Array.from({ length: 501 }, (_, i) => `m-${i + 1}`);

    client.send({ id: 2, method: 'mail.markRead', params: { projectPath: dir, workId, messageIds } });
    expect((await reply(client, 2)).error?.code).toBe('bad_request');
    expect((await readMap(dir, workId)).messages[0]?.readBy[HUMAN]).toBeUndefined();
    client.close();
  });
});
