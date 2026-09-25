import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { connectRaw, hello, removeHome, tempHome, waitClosed, waitConnected } from '../test/helpers.js';
import { startHost } from './host.js';
import type { RunningHost } from './host.js';
import { hostPaths } from './paths.js';

let hosts: RunningHost[] = [];
let homes: string[] = [];

async function boot(options: Parameters<typeof startHost>[0] = {}): Promise<{
  running: RunningHost;
  token: string;
  home: string;
}> {
  const home = await tempHome();
  homes.push(home);
  const running = await startHost({ home, ...options });
  hosts.push(running);
  const token = await readFile(hostPaths(home).token, 'utf8');
  return { running, token, home };
}

afterEach(async () => {
  await Promise.all(hosts.map((h) => h.context.shutdown('test-cleanup').catch(() => {})));
  hosts = [];
  await Promise.all(homes.map((home) => removeHome(home)));
  homes = [];
});

describe('рукопожатие', () => {
  it('чужой токен — unauthorized, соединение закрыто', async () => {
    const { home } = await boot();
    const client = connectRaw(hostPaths(home).socket);
    await waitConnected(client.socket);

    const response = await hello(client, 'не-тот-токен');
    expect(response.error).toMatchObject({ code: 'unauthorized' });
    await waitClosed(client.socket);
  });

  it('protocol: 999 — protocol_mismatch с версией хоста и liveSessions: 0', async () => {
    const { home, token } = await boot({ version: '9.9.9' });
    const client = connectRaw(hostPaths(home).socket);
    await waitConnected(client.socket);

    const response = await hello(client, token, { protocol: 999 });
    expect(response.error?.code).toBe('protocol_mismatch');
    expect(response.error?.data).toMatchObject({ hostVersion: '9.9.9', liveSessions: 0 });
    await waitClosed(client.socket);
  });

  it('запрос до hello — unauthorized', async () => {
    const { home } = await boot();
    const client = connectRaw(hostPaths(home).socket);
    await waitConnected(client.socket);

    client.send({ id: 1, method: 'host.info', params: {} });
    const response = await client.next();
    expect(response.error).toMatchObject({ code: 'unauthorized' });
    await waitClosed(client.socket);
  });

  it('нет hello за helloTimeoutMs — соединение закрывается', async () => {
    const { home } = await boot({ helloTimeoutMs: 100 });
    const client = connectRaw(hostPaths(home).socket);
    await waitConnected(client.socket);

    await waitClosed(client.socket, 1000);
  });
});

describe('методы куска 1.3', () => {
  it('host.info считает клиентов', async () => {
    const { home, token } = await boot();

    const clientA = connectRaw(hostPaths(home).socket);
    await waitConnected(clientA.socket);
    await hello(clientA, token, { client: 'a' });

    const clientB = connectRaw(hostPaths(home).socket);
    await waitConnected(clientB.socket);
    await hello(clientB, token, { client: 'b' });

    clientA.send({ id: 100, method: 'host.info', params: {} });
    const response = await clientA.next();
    expect(response.result).toMatchObject({ clients: 2, liveSessions: 0 });

    clientA.close();
    clientB.close();
  });

  it('host.shutdown отвечает и следом удаляет сокет, токен и pid', async () => {
    const { home, token, running } = await boot();
    const client = connectRaw(hostPaths(home).socket);
    await waitConnected(client.socket);
    await hello(client, token);

    client.send({ id: 200, method: 'host.shutdown', params: {} });
    const response = await client.next();
    expect(response.result).toEqual({ ok: true });

    const reason = await running.closed;
    expect(reason).toBe('host.shutdown');
    expect(existsSync(hostPaths(home).socket)).toBe(false);
    expect(existsSync(hostPaths(home).token)).toBe(false);
    expect(existsSync(hostPaths(home).pid)).toBe(false);

    // Хост уже остановлен методом — из списка на общую очистку его убираем.
    hosts = hosts.filter((h) => h !== running);
    client.close();
  });
});
