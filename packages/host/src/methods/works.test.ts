import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addSession, readWorksIndex, transitionSession, updateMap, workPaths } from '@harnas/core';
import { connectRaw, hello, removeHome, tempHome, waitConnected } from '../../test/helpers.js';
import { startHost } from '../host.js';
import type { RunningHost } from '../host.js';
import { hostPaths } from '../paths.js';

let hosts: RunningHost[] = [];
let homes: string[] = [];
let projects: string[] = [];

async function boot(): Promise<{ home: string; token: string }> {
  const home = await tempHome();
  homes.push(home);
  const running = await startHost({ home });
  hosts.push(running);
  const token = await readFile(hostPaths(home).token, 'utf8');
  return { home, token };
}

async function project(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'harnas-methods-project-'));
  projects.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(hosts.map((h) => h.context.shutdown('test-cleanup').catch(() => {})));
  hosts = [];
  await Promise.all(homes.map((home) => removeHome(home)));
  homes = [];
  await Promise.all(projects.map((dir) => rm(dir, { recursive: true, force: true })));
  projects = [];
});

describe('works.create / works.delete', () => {
  it('works.create заводит каталог и запись индекса', async () => {
    const { home, token } = await boot();
    const dir = await project();
    const client = connectRaw(hostPaths(home).socket);
    await waitConnected(client.socket);
    await hello(client, token);

    client.send({
      id: 1,
      method: 'works.create',
      params: { projectPath: dir, title: 'Авторизация', goal: 'логин по паролю' },
    });
    const response = await client.next();
    const workId = (response.result as { workId: string }).workId;
    expect(workId).toBe('w-0001');

    expect((await readWorksIndex()).works).toContainEqual(
      expect.objectContaining({ id: workId, projectPath: dir, title: 'Авторизация' }),
    );
    expect(await readFile(workPaths(dir, workId).map, 'utf8')).toContain('Авторизация');

    client.close();
  });

  it('works.delete при живой сессии — conflict', async () => {
    const { home, token } = await boot();
    const dir = await project();
    const client = connectRaw(hostPaths(home).socket);
    await waitConnected(client.socket);
    await hello(client, token);

    client.send({ id: 1, method: 'works.create', params: { projectPath: dir, title: 'Работа', goal: '' } });
    const created = await client.next();
    const workId = (created.result as { workId: string }).workId;

    await updateMap(dir, workId, (map) => {
      const session = addSession(map, { provider: 'claude', label: 'план', task: 't' });
      session.pid = process.pid;
      transitionSession(map, session.id, 'active');
    });

    client.send({ id: 2, method: 'works.delete', params: { projectPath: dir, workId } });
    const response = await client.next();
    expect(response.error?.code).toBe('conflict');
    // Работа осталась на диске.
    expect(await readFile(workPaths(dir, workId).map, 'utf8')).toContain('Работа');

    client.close();
  });

  it('works.delete без живой сессии — удаляет', async () => {
    const { home, token } = await boot();
    const dir = await project();
    const client = connectRaw(hostPaths(home).socket);
    await waitConnected(client.socket);
    await hello(client, token);

    client.send({ id: 1, method: 'works.create', params: { projectPath: dir, title: 'Работа', goal: '' } });
    const created = await client.next();
    const workId = (created.result as { workId: string }).workId;

    client.send({ id: 2, method: 'works.delete', params: { projectPath: dir, workId } });
    const response = await client.next();
    expect(response.result).toEqual({ ok: true });
    expect((await readWorksIndex()).works).toEqual([]);

    client.close();
  });
});

describe('providers.list', () => {
  it('HARNAS_CLAUDE_BIN на исполняемый стаб — у claude available: true', async () => {
    const { home, token } = await boot();
    const stubDir = await mkdtemp(path.join(tmpdir(), 'harnas-stub-'));
    const stub = path.join(stubDir, 'claude-stub');
    await writeFile(stub, '#!/bin/sh\n', 'utf8');
    await chmod(stub, 0o755);
    const saved = process.env['HARNAS_CLAUDE_BIN'];
    process.env['HARNAS_CLAUDE_BIN'] = stub;

    try {
      const client = connectRaw(hostPaths(home).socket);
      await waitConnected(client.socket);
      await hello(client, token);

      client.send({ id: 1, method: 'providers.list', params: {} });
      const response = await client.next();
      const providers = (response.result as { providers: Array<{ id: string; available: boolean }> })
        .providers;
      expect(providers.find((p) => p.id === 'claude')?.available).toBe(true);

      client.close();
    } finally {
      if (saved === undefined) delete process.env['HARNAS_CLAUDE_BIN'];
      else process.env['HARNAS_CLAUDE_BIN'] = saved;
      await rm(stubDir, { recursive: true, force: true });
    }
  });
});

describe('settings.get / settings.set', () => {
  it('settings.get: ключ из переменной окружения попадает в locked', async () => {
    const { home, token } = await boot();
    const saved = process.env['HARNAS_MESSAGE_RATE'];
    process.env['HARNAS_MESSAGE_RATE'] = '5';

    try {
      const client = connectRaw(hostPaths(home).socket);
      await waitConnected(client.socket);
      await hello(client, token);

      client.send({ id: 1, method: 'settings.get', params: {} });
      const response = await client.next();
      const result = response.result as { locked: Record<string, string> };
      expect(result.locked['messageRate']).toBe('HARNAS_MESSAGE_RATE');

      client.close();
    } finally {
      if (saved === undefined) delete process.env['HARNAS_MESSAGE_RATE'];
      else process.env['HARNAS_MESSAGE_RATE'] = saved;
    }
  });

  it('settings.set с плохим значением — bad_request', async () => {
    const { home, token } = await boot();
    const client = connectRaw(hostPaths(home).socket);
    await waitConnected(client.socket);
    await hello(client, token);

    client.send({ id: 1, method: 'settings.set', params: { key: 'messageRate', value: 'абв' } });
    const response = await client.next();
    expect(response.error?.code).toBe('bad_request');

    client.close();
  });

  it('settings.set с хорошим значением — сохраняет и возвращает конфиг', async () => {
    const { home, token } = await boot();
    const client = connectRaw(hostPaths(home).socket);
    await waitConnected(client.socket);
    await hello(client, token);

    client.send({ id: 1, method: 'settings.set', params: { key: 'messageRate', value: '7' } });
    const response = await client.next();
    expect((response.result as { config: { messageRate: number } }).config.messageRate).toBe(7);

    client.close();
  });
});
