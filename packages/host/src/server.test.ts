import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addSession, createWork, updateMap, workPaths } from '@harnas/core';
import { METHODS, NOTIFICATIONS } from '@harnas/protocol';
import type { SessionRef } from '@harnas/protocol';
import { connectRaw, hello, removeHome, tempHome, waitClosed, waitConnected } from '../test/helpers.js';
import type { RawMessage, TestClient } from '../test/helpers.js';
import { startHost } from './host.js';
import type { RunningHost } from './host.js';
import { hostPaths } from './paths.js';

let hosts: RunningHost[] = [];
let homes: string[] = [];
let projects: string[] = [];

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
  await Promise.all(projects.map((dir) => rm(dir, { recursive: true, force: true })));
  projects = [];
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

describe('уведомления', () => {
  // Окно восстанавливает раскладку и шлёт `pty.resize` терминалу сессии, чей
  // PTY остался у прежнего хоста. Бросок обработчика уведомления ронял хост,
  // окно поднимало новый — и тот падал на том же уведомлении.
  it('брошенное обработчиком уведомления исключение не роняет хост', async () => {
    const { home, token } = await boot();
    const client = connectRaw(hostPaths(home).socket);
    await waitConnected(client.socket);
    await hello(client, token);

    const ref = { projectPath: '/нет-такого', workId: 'w-01', sessionId: 's-01' };
    client.send({ method: 'pty.resize', params: { ref, cols: 80, rows: 24 } });
    client.send({ method: 'pty.input', params: { ref, data: 'x' } });
    // activity.seen чужой сессии хост тихо пропускает (кусок 4.1).
    client.send({ method: 'activity.seen', params: { ref } });
    client.send({ id: 300, method: 'host.info', params: {} });

    const response = await client.next();
    expect(response.result).toMatchObject({ clients: 1 });
    client.close();
  });
});

/** Все методы и уведомления протокола — то, что понимает хост этой сборки. */
const protocolMethods = (): string[] => [...Object.keys(METHODS), ...Object.keys(NOTIFICATIONS)].sort();

describe('список методов в hello', () => {
  it('methods — ровно отсортированные ключи METHODS и NOTIFICATIONS, hello среди них', async () => {
    const { home, token } = await boot();
    const client = connectRaw(hostPaths(home).socket);
    await waitConnected(client.socket);

    const response = await hello(client, token);
    const methods = (response.result as { methods: string[] }).methods;
    expect(methods).toEqual(protocolMethods());
    expect(methods).toContain('hello');
    expect(methods).toContain('works.rename');
    expect(methods).toContain('works.setStatus');
    // Новые методы комнат (дизайн комнат, 3.2): окно по этому списку решает, показывать ли
    // вступление в комнату и кнопки решения.
    expect(methods).toContain('rooms.addMember');
    expect(methods).toContain('rooms.resolveProposal');
    client.close();
  });
});

describe('активность для нового клиента', () => {
  /** Следующее сообщение, подходящее под условие; остальные рассылки пропускаются. */
  async function nextMatching(
    client: TestClient,
    match: (message: RawMessage) => boolean,
    timeoutMs = 10_000,
  ): Promise<RawMessage> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('не дождались сообщения');
      const message = await Promise.race([
        client.next(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('не дождались сообщения')), left),
        ),
      ]);
      if (match(message)) return message;
    }
  }

  const blockedOf =
    (ref: SessionRef) =>
    (message: RawMessage): boolean => {
      if (message.event !== 'activity.changed') return false;
      const data = message.data as { ref: SessionRef; activity: { activity: string } };
      return data.ref.sessionId === ref.sessionId && data.activity.activity === 'blocked';
    };

  it('сессия в blocked: второй клиент сразу после ответа на hello получает её activity.changed', async () => {
    const { home, token } = await boot();
    const dir = await mkdtemp(path.join(tmpdir(), 'harnas-server-project-'));
    projects.push(dir);

    // Журнал с PermissionRequest лежит до записи сессии в карту: первое же
    // чтение журнала новой сессии видит её ждущей разрешения.
    const map = await createWork(dir, { title: 'Работа' });
    const events = workPaths(dir, map.work.id).events;
    await mkdir(events, { recursive: true });
    let sessionId = '';
    await updateMap(dir, map.work.id, (current) => {
      sessionId = addSession(current, { provider: 'claude', label: 'план', task: 'т' }).id;
    });
    await writeFile(
      path.join(events, `${sessionId}.jsonl`),
      `${JSON.stringify({ hook_event_name: 'UserPromptSubmit' })}\n${JSON.stringify({ hook_event_name: 'PermissionRequest' })}\n`,
    );
    const ref: SessionRef = { projectPath: dir, workId: map.work.id, sessionId };

    const first = connectRaw(hostPaths(home).socket);
    await waitConnected(first.socket);
    await hello(first, token, { client: 'first' });
    // Первый клиент дожидается blocked рассылкой — хост точно знает состояние.
    await nextMatching(first, blockedOf(ref));

    const second = connectRaw(hostPaths(home).socket);
    await waitConnected(second.socket);
    const response = await hello(second, token, { client: 'second' });
    expect((response.result as { methods: string[] }).methods).toEqual(protocolMethods());

    const replay = await second.next();
    expect(replay.event).toBe('activity.changed');
    expect(replay.data).toMatchObject({ ref, activity: { activity: 'blocked' } });

    first.close();
    second.close();
  }, 20_000);
});
