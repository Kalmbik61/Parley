import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addSession, createWork, updateMap, workPaths } from '@parley/core';
import {
  ASSISTANT_ACTIONS_FEATURE,
  BROWSER_AGENT_FEATURE,
  COMPACT_WORKS_FEATURE,
  METHODS,
  NOTIFICATIONS,
  PROTOCOL_VERSION,
  ROOMS_MAIL_FEATURE,
  encodeLine,
} from '@parley/protocol';
import { REMOTE_EVENTS, REMOTE_METHODS, REMOTE_POLICY_FEATURE } from '@parley/protocol/remote';
import type { SessionRef } from '@parley/protocol';
import { connectRaw, hello, removeHome, tempHome, waitClosed, waitConnected } from '../test/helpers.js';
import type { RawMessage, TestClient } from '../test/helpers.js';
import { startHost } from './host.js';
import type { RunningHost } from './host.js';
import { hostPaths } from './paths.js';
import { createHostServer, SLOW_REQUEST_MS } from './server.js';
import { HostError } from './errors.js';
import type { HostContext } from './context.js';
import type { Client } from './client.js';

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
    expect(response.error).toMatchObject({ code: 'unauthorized', message: 'invalid token' });
    await waitClosed(client.socket);
  });

  it('hello.features содержит feed-codex', async () => {
    const { home, token } = await boot();
    const client = connectRaw(hostPaths(home).socket);
    await waitConnected(client.socket);

    const response = await hello(client, token);
    expect((response.result as { features: string[] }).features).toContain('feed-codex');
    client.close();
  });

  it('hello.features содержит rooms-mail', async () => {
    const { home, token } = await boot();
    const client = connectRaw(hostPaths(home).socket);
    await waitConnected(client.socket);

    const response = await hello(client, token);
    expect((response.result as { features: string[] }).features).toContain('rooms-mail');
    client.close();
  });

  it('protocol: 999 — protocol_mismatch с версией хоста и liveSessions: 0', async () => {
    const { home, token } = await boot({ version: '9.9.9' });
    const client = connectRaw(hostPaths(home).socket);
    await waitConnected(client.socket);

    const response = await hello(client, token, { protocol: 999 });
    expect(response.error?.code).toBe('protocol_mismatch');
    expect(response.error?.message).toBe(`host speaks protocol ${PROTOCOL_VERSION}, client sent 999`);
    expect(response.error?.data).toMatchObject({ hostVersion: '9.9.9', liveSessions: 0 });
    await waitClosed(client.socket);
  });

  it('запрос до hello — unauthorized', async () => {
    const { home } = await boot();
    const client = connectRaw(hostPaths(home).socket);
    await waitConnected(client.socket);

    client.send({ id: 1, method: 'host.info', params: {} });
    const response = await client.next();
    expect(response.error).toMatchObject({ code: 'unauthorized', message: 'the first message must be hello' });
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
  it('advertises a registered feed.progress handler and validates its strict params', async () => {
    const { home, token } = await boot();
    const client = connectRaw(hostPaths(home).socket);
    await waitConnected(client.socket);
    const response = await hello(client, token);
    expect((response.result as { methods: string[] }).methods).toContain('feed.progress');
    const ref = { projectPath: '/missing-progress-project', workId: 'w-1', sessionId: 's-01' };
    client.send({ id: 610, method: 'feed.progress', params: { ref } });
    expect((await client.next()).error).toMatchObject({ code: 'not_found' });
    for (const extra of [{ agentId: 'SECRET' }, { path: '/SECRET' }, { limit: 99 }]) {
      client.send({ id: 611, method: 'feed.progress', params: { ref, ...extra } });
      expect((await client.next()).error).toMatchObject({ code: 'bad_request' });
    }
    client.close();
  });

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
    // Лента вида «Chat» (план 2026-10-01, Task 2): без `feed.snapshot` окно вид Chat не предлагает.
    for (const name of ['feed.snapshot', 'feed.subscribe', 'feed.unsubscribe', 'feed.decide', 'feed.interrupt']) {
      expect(methods).toContain(name);
    }
    // Меню «модель · effort» в чате (спека нормалайзера, 5.9): без обоих методов смены окно меню не показывает.
    expect(methods).toContain('sessions.setEffort');
    expect(methods).toContain('sessions.setModel');
    // Rename сессии из меню её строки: без метода окно пункта не показывает.
    expect(methods).toContain('sessions.rename');
    // Архив комнаты: без обоих методов окно пунктов Archive и Reopen не показывает (useHostSupports).
    expect(methods).toContain('rooms.archive');
    expect(methods).toContain('rooms.reopen');
    // Расход токенов комнаты: без метода окно значок не показывает (useHostSupports).
    expect(methods).toContain('rooms.usage');
    // Согласия на папку для Codex (спека 2026-10-21, 4.4): без них окно, остров и Settings → Projects молчат.
    for (const name of ['consents.list', 'consents.decide', 'trust.list', 'trust.check', 'trust.grant', 'trust.revoke']) {
      expect(methods).toContain(name);
    }
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
    const dir = await mkdtemp(path.join(tmpdir(), 'parley-server-project-'));
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

describe('канал агента к браузеру: от HTTP до окна и обратно (спека браузера 3.7; этап B2)', () => {
  const STUB = fileURLToPath(new URL('../test/stub-agent.mjs', import.meta.url));
  const PAGE = 'http://localhost:5173/';

  /** Следующее сообщение, подходящее под условие; остальные рассылки пропускаются. */
  async function until(client: TestClient, match: (message: RawMessage) => boolean, timeoutMs = 10_000): Promise<RawMessage> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('не дождались сообщения');
      const message = await Promise.race([
        client.next(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('не дождались сообщения')), left)),
      ]);
      if (match(message)) return message;
    }
  }

  async function post(url: string, token: string, body: unknown): Promise<{ status: number; json: unknown }> {
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, json: text === '' ? null : (JSON.parse(text) as unknown) };
  }

  it('токен сессии — из её конфига MCP; операция уходит окну с browser-agent и возвращается ответом окна; окно ушло — window_not_connected; сессия остановлена — токен 401', async () => {
    const { home, token } = await boot();
    const project = await mkdtemp(path.join(tmpdir(), 'parley-server-agent-'));
    projects.push(project);
    const argsFile = path.join(project, 'args.json');
    process.env['PARLEY_CLAUDE_BIN'] = STUB;
    process.env['STUB_ARGS_FILE'] = argsFile;
    try {
      const map = await createWork(project, { title: 'Работа' });
      const window = connectRaw(hostPaths(home).socket);
      await waitConnected(window.socket);
      const answer = await hello(window, token, { client: 'desktop', features: [BROWSER_AGENT_FEATURE] });
      expect((answer.result as { methods: string[] }).methods).toContain('browser.agentResult');

      window.send({ id: 901, method: 'sessions.create', params: { projectPath: project, workId: map.work.id, provider: 'claude', label: 'агент', task: '', parent: null } });
      const created = await until(window, (message) => message.id === 901);
      expect(created.error).toBeUndefined();
      const ref = (created.result as { ref: SessionRef }).ref;

      // Адрес и токен — из конфига MCP-сервера, как их берёт настоящий parley-mcp.
      const deadline = Date.now() + 10_000;
      while (!existsSync(argsFile)) {
        if (Date.now() > deadline) throw new Error('стаб не записал аргументы');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const args = JSON.parse(await readFile(argsFile, 'utf8')) as { argv: string[]; env: Record<string, string | null> };
      const config = JSON.parse(await readFile(args.argv[args.argv.indexOf('--mcp-config') + 1] as string, 'utf8')) as {
        mcpServers: { parley: { env: Record<string, string> } };
      };
      const { PARLEY_AGENT_URL: url, PARLEY_AGENT_TOKEN: agentToken } = config.mcpServers.parley.env;
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/agent\/browser$/);
      expect(agentToken).toMatch(/^[0-9a-f]{64}$/);
      expect(args.env['PARLEY_AGENT_TOKEN']).toBeNull();

      // Чужой токен — 401.
      expect((await post(url as string, 'f'.repeat(64), { op: 'open', args: { url: PAGE } })).status).toBe(401);

      // Операция: HTTP → окно (событие) → окно отвечает методом → HTTP.
      const opened = post(url as string, agentToken as string, { op: 'open', args: { url: PAGE } });
      const event = await until(window, (message) => message.event === 'browser.agentOp');
      expect(event.data).toMatchObject({ ref, label: 'S01', op: 'open', args: { url: PAGE } });
      const { opId } = event.data as { opId: string };
      const result = { tab: 't1', url: PAGE, reused: false, notes: [] };
      window.send({ id: 902, method: 'browser.agentResult', params: { opId, ok: true, result } });
      expect((await until(window, (message) => message.id === 902)).result).toEqual({ accepted: true });
      expect(await opened).toEqual({ status: 200, json: { ok: true, result } });
      // Поздний повтор того же ответа — не принят.
      window.send({ id: 903, method: 'browser.agentResult', params: { opId, ok: true, result } });
      expect((await until(window, (message) => message.id === 903)).result).toEqual({ accepted: false });

      // Окно ушло посреди операции — агенту сразу window_not_connected.
      const dropped = post(url as string, agentToken as string, { op: 'open', args: { url: PAGE } });
      await until(window, (message) => message.event === 'browser.agentOp');
      window.close();
      expect(await dropped).toEqual({ status: 200, json: { ok: false, error: { code: 'window_not_connected', message: expect.any(String) as unknown as string } } });

      // Окон нет совсем — тот же отказ, без ожидания.
      expect((await post(url as string, agentToken as string, { op: 'open', args: { url: PAGE } })).json).toMatchObject({ ok: false, error: { code: 'window_not_connected' } });

      // Сессия остановлена — токен снят.
      const second = connectRaw(hostPaths(home).socket);
      await waitConnected(second.socket);
      await hello(second, token, { client: 'desktop', features: [BROWSER_AGENT_FEATURE] });
      second.send({ id: 904, method: 'sessions.stop', params: { ref } });
      await until(second, (message) => message.id === 904);
      const stopDeadline = Date.now() + 10_000;
      for (;;) {
        const status = (await post(url as string, agentToken as string, { op: 'open', args: { url: PAGE } })).status;
        if (status === 401) break;
        if (Date.now() > stopDeadline) throw new Error('токен остановленной сессии остался в силе');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      second.close();
    } finally {
      delete process.env['PARLEY_CLAUDE_BIN'];
      delete process.env['STUB_ARGS_FILE'];
    }
  }, 40_000);
});

describe('медленные запросы', () => {
  /** Сервер без хоста: свои обработчики и часы, которые отдают заданные отметки по одной на вызов. */
  async function slowServer(marks: number[], handler: () => Promise<unknown>) {
    const home = await tempHome();
    homes.push(home);
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const context = { version: 'test', log, liveSessions: () => 0 } as unknown as HostContext;
    const queue = [...marks];
    const server = createHostServer({
      context,
      token: 't',
      helloTimeoutMs: 5000,
      methodHandlers: { 'host.info': handler as never },
      notificationHandlers: {},
      registerClient: () => {},
      unregisterClient: () => {},
      now: () => queue.shift() ?? 0,
    });
    const socketPath = path.join(home, 'slow.sock');
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const client = connectRaw(socketPath);
    await waitConnected(client.socket);
    await hello(client, 't');
    return { log, client, close: () => { client.close(); server.close(); } };
  }

  it('запрос от порога и дольше пишет строку с method, ms и bytes', async () => {
    const { log, client, close } = await slowServer([0, SLOW_REQUEST_MS + 500], async () => ({ ok: true }));
    client.send({ id: 900, method: 'host.info', params: {} });
    await client.next();
    expect(log.warn).toHaveBeenCalledWith('медленный запрос', expect.objectContaining({
      method: 'host.info',
      ms: SLOW_REQUEST_MS + 500,
      bytes: Buffer.byteLength(JSON.stringify({ ok: true }), 'utf8'),
    }));
    close();
  });

  it('быстрый запрос строки не пишет', async () => {
    const { log, client, close } = await slowServer([0, 10], async () => ({ ok: true }));
    client.send({ id: 901, method: 'host.info', params: {} });
    await client.next();
    expect(log.warn).not.toHaveBeenCalled();
    close();
  });

  it('медленная ошибка пишет поле error с кодом и без bytes', async () => {
    const { log, client, close } = await slowServer([0, 2000], async () => {
      throw new HostError('conflict', 'занято');
    });
    client.send({ id: 902, method: 'host.info', params: {} });
    await client.next();
    const fields = log.warn.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(log.warn.mock.calls[0]?.[0]).toBe('медленный запрос');
    expect(fields).toMatchObject({ method: 'host.info', ms: 2000, error: 'conflict' });
    expect(fields).not.toHaveProperty('bytes');
    close();
  });

  it('бросающий log.warn не даёт второго ответа: клиент получает ровно один result', async () => {
    const { log, client, close } = await slowServer([0, 2000], async () => ({ ok: true }));
    log.warn.mockImplementation(() => {
      throw new Error('диск полон');
    });
    client.send({ id: 903, method: 'host.info', params: {} });
    const first = await client.next();
    expect(first).toMatchObject({ id: 903, result: { ok: true } });
    client.send({ id: 904, method: 'host.info', params: {} });
    const second = await client.next();
    expect(second.id).toBe(904);
    expect(log.warn).toHaveBeenCalled();
    close();
  });
});

describe('роль remote: белый список этапа A (спека мобильного приложения 4.1–4.3)', () => {
  const remoteAdvertised = new Set<string>(['hello', ...REMOTE_METHODS]);

  /** Сообщения до ответа с этим `id` включительно: события, пришедшие раньше, видны все. */
  async function collectUntil(client: TestClient, id: number): Promise<RawMessage[]> {
    const seen: RawMessage[] = [];
    for (;;) {
      const message = await client.next();
      seen.push(message);
      if (message.id === id) return seen;
    }
  }

  async function connectAs(home: string, token: string, client: string, features?: string[]) {
    const socket = connectRaw(hostPaths(home).socket);
    await waitConnected(socket.socket);
    const answer = await hello(socket, token, { client, ...(features === undefined ? {} : { features }) });
    return { client: socket, answer: answer.result as { methods: string[]; features: string[] } };
  }

  it('hello: methods ⊆ REMOTE_METHODS ∪ {hello}, features содержит remote-policy-1; desktop видит все методы', async () => {
    const { home, token } = await boot();
    const remote = await connectAs(home, token, 'remote');
    expect(remote.answer.methods.length).toBeGreaterThan(1);
    for (const name of remote.answer.methods) expect(remoteAdvertised.has(name)).toBe(true);
    expect(remote.answer.methods).toContain('hello');
    expect(remote.answer.methods).toContain('works.list');
    expect(remote.answer.features).toContain(REMOTE_POLICY_FEATURE);

    const desktop = await connectAs(home, token, 'desktop');
    expect(desktop.answer.methods).toEqual(protocolMethods());
    expect(desktop.answer.features).toContain(REMOTE_POLICY_FEATURE);
    remote.client.close();
    desktop.client.close();
  });

  it('settings.set — unknown_method, works.list — результат', async () => {
    const { home, token } = await boot();
    const { client } = await connectAs(home, token, 'remote');
    client.send({ id: 10, method: 'settings.set', params: { key: 'telegram.enabled', value: 'true' } });
    expect((await client.next()).error).toMatchObject({ code: 'unknown_method' });
    client.send({ id: 11, method: 'works.list', params: {} });
    const listed = (await collectUntil(client, 11)).at(-1);
    expect(listed?.error).toBeUndefined();
    expect(listed?.result).toBeDefined();
    client.close();
  });

  it('каждый метод протокола вне REMOTE_METHODS — unknown_method при любых параметрах, до схемы', async () => {
    const { home, token, running } = await boot();
    const { client } = await connectAs(home, token, 'remote');
    const allowed = new Set<string>(REMOTE_METHODS);
    const forbidden = Object.keys(METHODS).filter((name) => !allowed.has(name));
    expect(forbidden).toContain('host.shutdown');
    let id = 1000;
    for (const method of forbidden) {
      id += 1;
      // Параметры, не проходящие ни одну схему: ответ — unknown_method, а не bad_request с текстом схемы.
      client.send({ id, method, params: { '__no_such_field__': 1 } });
      const answer = (await collectUntil(client, id)).at(-1);
      expect(answer?.error, method).toMatchObject({ code: 'unknown_method' });
    }
    // Хост жив: host.shutdown до обработчика не дошёл.
    expect(running.context.clients()).toHaveLength(1);
    client.close();
  });

  it('повторный hello не меняет роль: ответ unknown_method, settings.set по-прежнему закрыт', async () => {
    const { home, token, running } = await boot();
    const { client } = await connectAs(home, token, 'remote');
    client.send({ id: 20, method: 'hello', params: { token, protocol: PROTOCOL_VERSION, client: 'desktop' } });
    expect((await collectUntil(client, 20)).at(-1)?.error).toMatchObject({ code: 'unknown_method' });
    client.send({ id: 21, method: 'settings.set', params: { key: 'k', value: 'v' } });
    expect((await collectUntil(client, 21)).at(-1)?.error).toMatchObject({ code: 'unknown_method' });
    expect(running.context.clients().map((entry) => entry.role)).toEqual(['remote']);
    client.close();
  });

  it('broadcast: telegram.changed и feed.changed (и готовой строкой) не доходят, works.changed доходит; feed.changed через client.send отфильтрован', async () => {
    const { home, token, running } = await boot();
    const { client } = await connectAs(home, token, 'remote');
    const registered = running.context.clients().find((entry) => entry.role === 'remote');
    expect(registered).toBeDefined();

    running.context.broadcast('telegram.changed', { marker: 'forbidden-1' } as never);
    const feedData = { marker: 'forbidden-2' };
    running.context.broadcast('feed.changed', feedData as never, undefined, encodeLine({ event: 'feed.changed', data: feedData } as never));
    registered?.send({ event: 'feed.changed', data: { marker: 'forbidden-3' } } as never);
    registered?.sendLine?.(encodeLine({ event: 'pty.output', data: { marker: 'forbidden-4' } } as never));
    running.context.broadcast('works.changed', { marker: 'allowed' } as never);
    client.send({ id: 30, method: 'host.info', params: {} });

    const seen = await collectUntil(client, 30);
    const events = seen.filter((message) => message.event !== undefined);
    for (const message of events) expect((REMOTE_EVENTS as readonly string[]).includes(message.event as string)).toBe(true);
    expect(JSON.stringify(seen)).not.toContain('forbidden-');
    expect(events).toContainEqual({ event: 'works.changed', data: { marker: 'allowed' } });
    client.close();
  });

  it('признаки remote — только compact-works и rooms-mail: заявленный browser-agent / assistant-actions не делает мост окном', async () => {
    const { home, token, running } = await boot();
    const { client } = await connectAs(home, token, 'remote', [
      BROWSER_AGENT_FEATURE,
      `${BROWSER_AGENT_FEATURE}:open`,
      ASSISTANT_ACTIONS_FEATURE,
      COMPACT_WORKS_FEATURE,
      ROOMS_MAIL_FEATURE,
    ]);
    const [registered] = running.context.clients();
    expect(registered?.role).toBe('remote');
    expect([...(registered?.features ?? [])].sort()).toEqual([COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE].sort());
    // Те же условия, по которым хост выбирает окно для операций браузера и решает, показаны ли действия ассистента.
    expect(running.context.clients().filter((entry) => entry.features.has(BROWSER_AGENT_FEATURE))).toEqual([]);
    expect(running.context.clients().some((entry) => entry.features.has(ASSISTANT_ACTIONS_FEATURE))).toBe(false);

    // Полный клиент заявляет то же — и получает всё заявленное.
    const desktop = await connectAs(home, token, 'desktop', [BROWSER_AGENT_FEATURE, ASSISTANT_ACTIONS_FEATURE]);
    const full = running.context.clients().find((entry) => entry.role === undefined);
    expect(full?.features.has(BROWSER_AGENT_FEATURE)).toBe(true);
    expect(full?.features.has(ASSISTANT_ACTIONS_FEATURE)).toBe(true);
    client.close();
    desktop.client.close();
  });

  describe('сервер со шпионами', () => {
    async function spyServer() {
      const home = await tempHome();
      homes.push(home);
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const context = { version: 'test', log, liveSessions: () => 0 } as unknown as HostContext;
      const resolveProposal = vi.fn(async () => ({ messageId: 'm-1' }));
      const settingsSet = vi.fn(async () => ({}));
      const ptyInput = vi.fn();
      const ptyResize = vi.fn();
      const registered: Client[] = [];
      const server = createHostServer({
        context,
        token: 't',
        helloTimeoutMs: 5000,
        methodHandlers: { 'rooms.resolveProposal': resolveProposal as never, 'settings.set': settingsSet as never, 'host.info': (async () => ({})) as never },
        notificationHandlers: { 'pty.input': ptyInput as never, 'pty.resize': ptyResize as never },
        registerClient: (client) => registered.push(client),
        unregisterClient: () => {},
      });
      const socketPath = path.join(home, 'spy.sock');
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      const connect = async (name?: string): Promise<TestClient> => {
        const client = connectRaw(socketPath);
        await waitConnected(client.socket);
        if (name !== undefined) await hello(client, 't', { client: name });
        return client;
      };
      return { log, resolveProposal, settingsSet, ptyInput, ptyResize, registered, connect, close: () => server.close() };
    }

    const proposal = { projectPath: '/p', workId: 'w-1', roomId: 'r-1', proposalId: 'm-1', action: 'accept' };
    const ref = { projectPath: '/p', workId: 'w-1', sessionId: 's-01' };

    it('rooms.resolveProposal без rev — bad_request, обработчик не вызван; с rev — вызван; у desktop без rev — вызван', async () => {
      const spies = await spyServer();
      const remote = await spies.connect('remote');
      remote.send({ id: 40, method: 'rooms.resolveProposal', params: proposal });
      expect((await remote.next()).error).toMatchObject({ code: 'bad_request' });
      expect(spies.resolveProposal).not.toHaveBeenCalled();
      remote.send({ id: 41, method: 'rooms.resolveProposal', params: { ...proposal, rev: 0 } });
      expect((await remote.next()).result).toEqual({ messageId: 'm-1' });
      expect(spies.resolveProposal).toHaveBeenCalledTimes(1);

      const desktop = await spies.connect('desktop');
      desktop.send({ id: 42, method: 'rooms.resolveProposal', params: proposal });
      expect((await desktop.next()).result).toEqual({ messageId: 'm-1' });
      expect(spies.resolveProposal).toHaveBeenCalledTimes(2);
      remote.close();
      desktop.close();
      spies.close();
    });

    it('уведомления pty.input и pty.resize от remote до обработчика не доходят и пишутся в лог; от desktop — доходят', async () => {
      const spies = await spyServer();
      const remote = await spies.connect('remote');
      remote.send({ method: 'pty.input', params: { ref, data: 'rm -rf ~\r' } });
      remote.send({ method: 'pty.resize', params: { ref, cols: 80, rows: 24 } });
      // Уведомление с нечисловым id — тоже уведомление, а не запрос в обход списка.
      remote.send({ id: 'x', method: 'pty.input', params: { ref, data: 'x' } });
      remote.send({ id: 43, method: 'host.info', params: {} });
      expect((await remote.next()).id).toBe(43);
      expect(spies.ptyInput).not.toHaveBeenCalled();
      expect(spies.ptyResize).not.toHaveBeenCalled();
      const dropped = spies.log.warn.mock.calls.map((call) => (call[1] as { method?: string }).method);
      expect(dropped).toEqual(['pty.input', 'pty.resize', 'pty.input']);

      const desktop = await spies.connect('desktop');
      desktop.send({ method: 'pty.input', params: { ref, data: 'x' } });
      desktop.send({ method: 'pty.resize', params: { ref, cols: 80, rows: 24 } });
      desktop.send({ id: 44, method: 'host.info', params: {} });
      expect((await desktop.next()).id).toBe(44);
      expect(spies.ptyInput).toHaveBeenCalledTimes(1);
      expect(spies.ptyResize).toHaveBeenCalledTimes(1);
      remote.close();
      desktop.close();
      spies.close();
    });

    it('запрос с id-уведомлением (pty.input с числовым id) от remote — unknown_method, обработчик не вызван', async () => {
      const spies = await spyServer();
      const remote = await spies.connect('remote');
      remote.send({ id: 45, method: 'pty.input', params: { ref, data: 'x' } });
      expect((await remote.next()).error).toMatchObject({ code: 'unknown_method' });
      expect(spies.ptyInput).not.toHaveBeenCalled();
      remote.close();
      spies.close();
    });

    it('имена со свойств прототипа (constructor, toString, __proto__) от remote — unknown_method или лог, до parseIncoming', async () => {
      const spies = await spyServer();
      const remote = await spies.connect('remote');
      let id = 50;
      for (const method of ['constructor', 'toString', '__proto__']) {
        id += 1;
        remote.send({ id, method, params: {} });
        expect((await remote.next()).error).toMatchObject({ code: 'unknown_method' });
        remote.send({ method, params: {} });
      }
      remote.send({ id: 59, method: 'host.info', params: {} });
      expect((await remote.next()).id).toBe(59);
      expect(spies.log.warn).toHaveBeenCalledTimes(3);
      remote.close();
      spies.close();
    });

    it('отклонённый hello — конец: верный hello следом в том же чанке не регистрирует клиента', async () => {
      const spies = await spyServer();
      const client = await spies.connect();
      const bad = { id: 1, method: 'hello', params: { token: 'не-тот', protocol: PROTOCOL_VERSION, client: 'remote' } };
      const good = { id: 2, method: 'hello', params: { token: 't', protocol: PROTOCOL_VERSION, client: 'desktop' } };
      const settings = { id: 3, method: 'settings.set', params: { key: 'k', value: 'v' } };
      client.socket.write(`${JSON.stringify(bad)}\n${JSON.stringify(good)}\n${JSON.stringify(settings)}\n`);
      expect((await client.next()).error).toMatchObject({ code: 'unauthorized' });
      await waitClosed(client.socket);
      expect(spies.registered).toEqual([]);
      expect(spies.settingsSet).not.toHaveBeenCalled();
      spies.close();
    });

    it('кадр до hello отклонён — следующий hello в том же чанке не принят', async () => {
      const spies = await spyServer();
      const client = await spies.connect();
      const early = { method: 'pty.input', params: { ref, data: 'x' } };
      const good = { id: 2, method: 'hello', params: { token: 't', protocol: PROTOCOL_VERSION, client: 'desktop' } };
      client.socket.write(`${JSON.stringify(early)}\n${JSON.stringify(good)}\n`);
      await waitClosed(client.socket);
      expect(spies.registered).toEqual([]);
      expect(spies.ptyInput).not.toHaveBeenCalled();
      spies.close();
    });
  });
});

describe('роль remote: запуск с телефона (A2b, спека мобильного приложения 4.2)', () => {
  const LAUNCH = ['sessions.create', 'rooms.create', 'rooms.send'];
  const STUB = fileURLToPath(new URL('../test/stub-agent.mjs', import.meta.url));

  async function collectUntil(client: TestClient, id: number, timeoutMs = 10_000): Promise<RawMessage[]> {
    const seen: RawMessage[] = [];
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no answer to ${id}`);
      const message = await Promise.race([
        client.next(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no answer to ${id}`)), left)),
      ]);
      seen.push(message);
      if (message.id === id) return seen;
    }
  }
  const answer = async (client: TestClient, id: number, method: string, params: unknown): Promise<RawMessage> => {
    client.send({ id, method, params });
    return (await collectUntil(client, id)).at(-1)!;
  };

  describe('сервер со шпионами', () => {
    async function launchServer(policy: { enabled: boolean; open: boolean; autonomous?: boolean } | null) {
      const home = await tempHome();
      homes.push(home);
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const context = { version: 'test', log, liveSessions: () => 0 } as unknown as HostContext;
      const spies = {
        'sessions.create': vi.fn(async () => ({ ref: { projectPath: '/p', workId: 'w-01', sessionId: 's-09' } })),
        'rooms.create': vi.fn(async () => ({ roomId: 'r-09' })),
        'rooms.send': vi.fn(async () => ({ messageId: 'm-09' })),
      };
      const workOpen = vi.fn(() => policy?.open ?? false);
      const roomAutonomous = vi.fn(() => policy?.autonomous ?? false);
      const state = { enabled: policy?.enabled ?? false };
      const server = createHostServer({
        context,
        token: 't',
        helloTimeoutMs: 5000,
        methodHandlers: spies as never,
        notificationHandlers: {},
        registerClient: () => {},
        unregisterClient: () => {},
        ...(policy === null
          ? {}
          : { remoteLaunch: { enabled: () => state.enabled, workOpen, roomAutonomous, projectKnown: () => true, workKnown: () => true } }),
      });
      const socketPath = path.join(home, 'launch.sock');
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      const clients: TestClient[] = [];
      const connect = async (name: string) => {
        const client = connectRaw(socketPath);
        clients.push(client);
        await waitConnected(client.socket);
        const reply = await hello(client, 't', { client: name });
        return { client, methods: (reply.result as { methods: string[] }).methods };
      };
      const close = () => {
        for (const client of clients) client.close();
        server.close();
      };
      return { spies, workOpen, roomAutonomous, state, connect, close };
    }

    const session = { projectPath: '/p', workId: 'w-01', provider: 'claude', label: 'fix', task: 'do it', parent: null };
    const room = { projectPath: '/p', workId: 'w-01', title: 'Review', members: ['s-01'] };
    const letter = { projectPath: '/p', workId: 'w-01', roomId: 'r-01', to: [], text: 'task', kind: 'note' };
    const calls: Array<[string, unknown]> = [
      ['sessions.create', session],
      ['rooms.create', room],
      ['rooms.send', letter],
    ];

    it('выключено: методов запуска нет в hello.methods, вызов → unknown_method, обработчик не вызван; desktop не затронут', async () => {
      const s = await launchServer({ enabled: false, open: true });
      const remote = await s.connect('remote');
      for (const name of LAUNCH) expect(remote.methods).not.toContain(name);
      let id = 100;
      for (const [method, params] of calls) {
        expect((await answer(remote.client, ++id, method, params)).error, method).toMatchObject({ code: 'unknown_method' });
        expect(s.spies[method as keyof typeof s.spies]).not.toHaveBeenCalled();
      }
      expect(s.workOpen).not.toHaveBeenCalled();

      const desktop = await s.connect('desktop');
      for (const name of LAUNCH) expect(desktop.methods).toContain(name);
      for (const [method, params] of calls) {
        expect((await answer(desktop.client, ++id, method, params)).error, method).toBeUndefined();
        expect(s.spies[method as keyof typeof s.spies]).toHaveBeenCalledTimes(1);
      }
      s.close();
    });

    it('без политики remoteLaunch запуск закрыт', async () => {
      const s = await launchServer(null);
      const remote = await s.connect('remote');
      for (const name of LAUNCH) expect(remote.methods).not.toContain(name);
      expect((await answer(remote.client, 110, 'sessions.create', session)).error).toMatchObject({ code: 'unknown_method' });
      expect(s.spies['sessions.create']).not.toHaveBeenCalled();
      s.close();
    });

    it('включено и работа открыта: методы в hello.methods, обработчики вызваны, workOpen получил проект и работу', async () => {
      const s = await launchServer({ enabled: true, open: true });
      const remote = await s.connect('remote');
      for (const name of LAUNCH) expect(remote.methods).toContain(name);
      let id = 120;
      for (const [method, params] of calls) {
        expect((await answer(remote.client, ++id, method, params)).error, method).toBeUndefined();
        expect(s.spies[method as keyof typeof s.spies]).toHaveBeenCalledTimes(1);
      }
      expect(s.workOpen.mock.calls).toEqual([['/p', 'w-01'], ['/p', 'w-01'], ['/p', 'w-01']]);
      s.close();
    });

    it('чужой проект или архивная работа (workOpen → false) — bad_request, обработчик не вызван', async () => {
      const s = await launchServer({ enabled: true, open: false });
      const remote = await s.connect('remote');
      let id = 130;
      for (const [method, params] of calls) {
        expect((await answer(remote.client, ++id, method, params)).error, method).toMatchObject({ code: 'bad_request' });
        expect(s.spies[method as keyof typeof s.spies]).not.toHaveBeenCalled();
      }
      s.close();
    });

    it('agent, autonomous, recipe, origin и решение — bad_request по правилам A1c, обработчик не вызван', async () => {
      const s = await launchServer({ enabled: true, open: true });
      const remote = await s.connect('remote');
      const bad: Array<[string, unknown]> = [
        ['sessions.create', { ...session, agent: 'x' }],
        ['sessions.create', { ...session, workId: null }],
        ['rooms.create', { ...room, mode: 'autonomous' }],
        ['rooms.create', { ...room, origin: ['s-01', 's-02'] }],
        ['rooms.create', { ...room, recipe: { id: 'r', source: 'builtin', name: 'n', mode: 'free', agents: [] } }],
        ['rooms.send', { ...letter, kind: 'decision' }],
        ['rooms.send', { ...letter, roomId: null }],
      ];
      let id = 140;
      for (const [method, params] of bad) {
        expect((await answer(remote.client, ++id, method, params)).error, JSON.stringify(params)).toMatchObject({ code: 'bad_request' });
      }
      for (const spy of Object.values(s.spies)) expect(spy).not.toHaveBeenCalled();
      s.close();
    });

    it('письмо remote в автономную комнату — bad_request, обработчик не вызван; desktop пишет как прежде', async () => {
      const s = await launchServer({ enabled: true, open: true, autonomous: true });
      const remote = await s.connect('remote');
      expect((await answer(remote.client, 160, 'rooms.send', letter)).error).toMatchObject({
        code: 'bad_request',
        message: 'the phone cannot write into an autonomous room',
      });
      expect(s.spies['rooms.send']).not.toHaveBeenCalled();
      expect(s.roomAutonomous.mock.calls).toEqual([['/p', 'w-01', 'r-01']]);
      // Запуск сессии и комнаты от режима комнат не зависит.
      expect((await answer(remote.client, 161, 'rooms.create', room)).error).toBeUndefined();
      const desktop = await s.connect('desktop');
      expect((await answer(desktop.client, 162, 'rooms.send', letter)).error).toBeUndefined();
      expect(s.spies['rooms.send']).toHaveBeenCalledTimes(1);
      s.close();
    });

    describe('проекты чтений и решений (критик W11)', () => {
      const ref = { projectPath: '/p', workId: 'w-01', sessionId: 's-01' };
      const reads: Array<[string, Record<string, unknown>]> = [
        ['context.messages', { projectPath: '/p', workId: 'w-01', roomId: null }],
        ['context.letter', { projectPath: '/p', workId: 'w-01', id: 'm-1' }],
        ['context.text', { projectPath: '/p', workId: 'w-01', ref: { kind: 'goal' } }],
        ['roles.list', { projectPath: '/p' }],
        ['feed.snapshot', { ref }],
        ['feed.decide', { ref, cardId: 'c-1', decision: { kind: 'permission', behavior: 'deny' } }],
        ['rooms.resolveProposal', { projectPath: '/p', workId: 'w-01', roomId: 'r-1', proposalId: 'm-1', action: 'accept', rev: 0 }],
      ];

      async function readServer(known: { projects: string[]; works: string[] }) {
        const home = await tempHome();
        homes.push(home);
        const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
        const context = { version: 'test', log, liveSessions: () => 0 } as unknown as HostContext;
        const spies = Object.fromEntries(
          [...reads.map(([method]) => method), 'works.list', 'host.info', 'providers.list'].map((method) => [method, vi.fn(async () => ({ ok: true }))]),
        );
        const server = createHostServer({
          context,
          token: 't',
          helloTimeoutMs: 5000,
          methodHandlers: spies as never,
          notificationHandlers: {},
          registerClient: () => {},
          unregisterClient: () => {},
          remoteLaunch: {
            enabled: () => true,
            workOpen: () => true,
            roomAutonomous: () => false,
            projectKnown: (projectPath) => known.projects.includes(projectPath),
            workKnown: (projectPath, workId) => known.works.includes(`${projectPath}#${workId}`),
          },
        });
        const socketPath = path.join(home, 'reads.sock');
        await new Promise<void>((resolve) => server.listen(socketPath, resolve));
        const clients: TestClient[] = [];
        const connect = async (name: string) => {
          const client = connectRaw(socketPath);
          clients.push(client);
          await waitConnected(client.socket);
          await hello(client, 't', { client: name });
          return client;
        };
        return { spies, connect, close: () => { for (const c of clients) c.close(); server.close(); } };
      }

      it('неизвестный проект или работа — bad_request, обработчик не вызван; методы без проекта не затронуты', async () => {
        const s = await readServer({ projects: [], works: [] });
        const remote = await s.connect('remote');
        let id = 170;
        for (const [method, params] of reads) {
          expect((await answer(remote, ++id, method, params)).error, method).toMatchObject({ code: 'bad_request', message: 'unknown project or work' });
          expect(s.spies[method], method).not.toHaveBeenCalled();
        }
        for (const method of ['works.list', 'host.info', 'providers.list']) {
          expect((await answer(remote, ++id, method, {})).error, method).toBeUndefined();
        }
        // Полный клиент проект не сверяет: те же вызовы доходят до обработчиков.
        const desktop = await s.connect('desktop');
        for (const [method, params] of reads) {
          expect((await answer(desktop, ++id, method, params)).error, method).toBeUndefined();
          expect(s.spies[method], method).toHaveBeenCalledTimes(1);
        }
        s.close();
      });

      it('известные проект и работа — обработчики вызваны; ref roles.list в чужую работу — bad_request', async () => {
        const s = await readServer({ projects: ['/p'], works: ['/p#w-01'] });
        const remote = await s.connect('remote');
        let id = 190;
        for (const [method, params] of reads) {
          expect((await answer(remote, ++id, method, params)).error, method).toBeUndefined();
          expect(s.spies[method], method).toHaveBeenCalledTimes(1);
        }
        expect((await answer(remote, ++id, 'roles.list', { projectPath: '/p', ref: { projectPath: '/other', workId: 'w-01', sessionId: 's-01' } })).error)
          .toMatchObject({ code: 'bad_request' });
        expect((await answer(remote, ++id, 'feed.snapshot', { ref: { ...ref, workId: 'w-02' } })).error).toMatchObject({ code: 'bad_request' });
        expect(s.spies['roles.list']).toHaveBeenCalledTimes(1);
        expect(s.spies['feed.snapshot']).toHaveBeenCalledTimes(1);
        s.close();
      });
    });

    it('переключатель выключен после hello — следующий вызов получает unknown_method', async () => {
      const s = await launchServer({ enabled: true, open: true });
      const remote = await s.connect('remote');
      s.state.enabled = false;
      expect((await answer(remote.client, 150, 'rooms.send', letter)).error).toMatchObject({ code: 'unknown_method' });
      expect(s.spies['rooms.send']).not.toHaveBeenCalled();
      s.close();
    });
  });

  describe('живой хост', () => {
    async function project(): Promise<{ dir: string; workId: string; sessions: string[] }> {
      const dir = await mkdtemp(path.join(tmpdir(), 'parley-remote-launch-'));
      projects.push(dir);
      const map = await createWork(dir, { title: 'Работа' });
      const sessions: string[] = [];
      await updateMap(dir, map.work.id, (current) => {
        sessions.push(addSession(current, { provider: 'claude', label: 'a', task: 't' }).id);
        sessions.push(addSession(current, { provider: 'claude', label: 'b', task: 't' }).id);
      });
      return { dir, workId: map.work.id, sessions };
    }

    async function connectAs(home: string, token: string, name: string): Promise<{ client: TestClient; methods: string[] }> {
      const client = connectRaw(hostPaths(home).socket);
      await waitConnected(client.socket);
      const reply = await hello(client, token, { client: name });
      return { client, methods: (reply.result as { methods: string[] }).methods };
    }

    /** Ждёт, пока хост прочитает работу: до этого запуск в неё — bad_request. */
    async function waitWork(client: TestClient, workId: string): Promise<void> {
      const deadline = Date.now() + 10_000;
      for (let id = 5000; ; id++) {
        const reply = await answer(client, id, 'works.list', {});
        if (JSON.stringify(reply.result ?? null).includes(`"${workId}"`)) return;
        if (Date.now() > deadline) throw new Error('host did not read the work');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    it('включено: сессия и комната создаются, письмо уходит; чужой проект и архивная работа — bad_request', async () => {
      process.env['PARLEY_CLAUDE_BIN'] = STUB;
      try {
        const { home, token } = await boot();
        const p = await project();
        const remote = await connectAs(home, token, 'remote');
        for (const name of LAUNCH) expect(remote.methods).toContain(name);
        await waitWork(remote.client, p.workId);

        const created = await answer(remote.client, 200, 'sessions.create', {
          projectPath: p.dir, workId: p.workId, provider: 'claude', label: 'from phone', task: 'task', parent: null,
        });
        expect(created.error).toBeUndefined();
        expect((created.result as { ref: SessionRef }).ref).toMatchObject({ projectPath: p.dir, workId: p.workId });

        const room = await answer(remote.client, 201, 'rooms.create', {
          projectPath: p.dir, workId: p.workId, title: 'Phone room', members: p.sessions, lead: p.sessions[0], quiet: true, mode: 'free',
        });
        expect(room.error).toBeUndefined();
        const { roomId } = room.result as { roomId: string };

        const sent = await answer(remote.client, 202, 'rooms.send', {
          projectPath: p.dir, workId: p.workId, roomId, to: [], text: 'the task', kind: 'note',
        });
        expect(sent.error).toBeUndefined();
        expect((sent.result as { messageId: string }).messageId).toBeTruthy();

        const foreign = await mkdtemp(path.join(tmpdir(), 'parley-remote-foreign-'));
        projects.push(foreign);
        // Чтения (критик W11): своя работа читается, чужой путь — bad_request.
        expect((await answer(remote.client, 210, 'context.messages', { projectPath: p.dir, workId: p.workId, roomId })).error).toBeUndefined();
        expect((await answer(remote.client, 211, 'roles.list', { projectPath: p.dir })).error).toBeUndefined();
        expect((await answer(remote.client, 212, 'context.messages', { projectPath: foreign, workId: p.workId, roomId: null })).error)
          .toMatchObject({ code: 'bad_request', message: 'unknown project or work' });
        expect((await answer(remote.client, 213, 'roles.list', { projectPath: foreign })).error)
          .toMatchObject({ code: 'bad_request', message: 'unknown project or work' });
        expect((await answer(remote.client, 203, 'sessions.create', {
          projectPath: foreign, workId: p.workId, provider: 'claude', label: 'x', task: '', parent: null,
        })).error).toMatchObject({ code: 'bad_request', message: 'unknown project or work' });
        expect((await answer(remote.client, 204, 'rooms.create', {
          projectPath: p.dir, workId: 'w-99', title: 'x', members: p.sessions,
        })).error).toMatchObject({ code: 'bad_request', message: 'unknown project or work' });

        // Комната ушла в автономный режим: письмо с телефона в неё не уходит, у окна — уходит.
        await updateMap(p.dir, p.workId, (current) => {
          const target = current.rooms.find((entry) => entry.id === roomId);
          if (target) target.mode = 'autonomous';
        });
        const autonomousDeadline = Date.now() + 10_000;
        for (let id = 250; ; id++) {
          const reply = await answer(remote.client, id, 'rooms.send', {
            projectPath: p.dir, workId: p.workId, roomId, to: [], text: 'steer', kind: 'note',
          });
          if (reply.error?.message === 'the phone cannot write into an autonomous room') break;
          if (Date.now() > autonomousDeadline) throw new Error('the autonomous room stayed open for the phone');
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const desktop = await connectAs(home, token, 'desktop');
        expect((await answer(desktop.client, 290, 'rooms.send', {
          projectPath: p.dir, workId: p.workId, roomId, to: [], text: 'from the window', kind: 'note',
        })).error).toBeUndefined();
        expect((await answer(desktop.client, 205, 'works.setStatus', { projectPath: p.dir, workId: p.workId, status: 'archived' })).error).toBeUndefined();
        const deadline = Date.now() + 10_000;
        for (let id = 300; ; id++) {
          const reply = await answer(remote.client, id, 'rooms.send', {
            projectPath: p.dir, workId: p.workId, roomId, to: [], text: 'late', kind: 'note',
          });
          if (reply.error?.message === 'unknown project or work') break;
          if (Date.now() > deadline) throw new Error('archived work stayed open for the phone');
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        // Архивная работа закрыта для запуска, но читается: телефон видит архивные работы в проекции.
        expect((await answer(remote.client, 399, 'context.messages', { projectPath: p.dir, workId: p.workId, roomId })).error).toBeUndefined();
        remote.client.close();
        desktop.client.close();
      } finally {
        delete process.env['PARLEY_CLAUDE_BIN'];
      }
    }, 40_000);

    it('смена remoteCreate закрывает сокеты клиентов remote, полный клиент не тронут; новый hello — с новым списком', async () => {
      const { home, token } = await boot();
      const desktop = await connectAs(home, token, 'desktop');
      const first = await connectAs(home, token, 'remote');
      for (const name of LAUNCH) expect(first.methods).toContain(name);

      // То же значение — не смена: соединение остаётся.
      expect((await answer(desktop.client, 400, 'settings.set', { key: 'remoteCreate', value: '1' })).error).toBeUndefined();
      expect((await answer(first.client, 401, 'host.info', {})).error).toBeUndefined();

      expect((await answer(desktop.client, 402, 'settings.set', { key: 'remoteCreate', value: '0' })).error).toBeUndefined();
      await waitClosed(first.client.socket, 2000);
      expect((await answer(desktop.client, 403, 'host.info', {})).error).toBeUndefined();

      const second = await connectAs(home, token, 'remote');
      for (const name of LAUNCH) expect(second.methods).not.toContain(name);
      expect(second.methods).toContain('providers.list');
      expect(second.methods).toContain('roles.list');
      expect((await answer(second.client, 404, 'rooms.send', {
        projectPath: '/p', workId: 'w-01', roomId: 'r-01', to: [], text: 'x', kind: 'note',
      })).error).toMatchObject({ code: 'unknown_method' });

      expect((await answer(desktop.client, 405, 'settings.set', { key: 'remoteCreate', value: '1' })).error).toBeUndefined();
      await waitClosed(second.client.socket, 2000);
      const third = await connectAs(home, token, 'remote');
      for (const name of LAUNCH) expect(third.methods).toContain(name);
      third.client.close();
      desktop.client.close();
    });

    it('лимит запусков хоста срабатывает для remote так же, как для окна', async () => {
      process.env['PARLEY_CLAUDE_BIN'] = STUB;
      try {
        const { home, token } = await boot();
        const p = await project();
        const desktop = await connectAs(home, token, 'desktop');
        expect((await answer(desktop.client, 500, 'settings.set', { key: 'workConcurrent', value: '1' })).error).toBeUndefined();
        const remote = await connectAs(home, token, 'remote');
        await waitWork(remote.client, p.workId);
        const params = (label: string) => ({ projectPath: p.dir, workId: p.workId, provider: 'claude', label, task: '', parent: null });

        expect((await answer(remote.client, 501, 'sessions.create', params('one'))).error).toBeUndefined();
        const fromPhone = await answer(remote.client, 502, 'sessions.create', params('two'));
        const fromWindow = await answer(desktop.client, 503, 'sessions.create', params('three'));
        expect(fromPhone.error).toMatchObject({ code: 'conflict', data: { code: 'resource-budget' } });
        expect(fromWindow.error).toMatchObject({ code: fromPhone.error?.code, data: { code: 'resource-budget', reason: fromPhone.error?.data?.['reason'] } });
        remote.client.close();
        desktop.client.close();
      } finally {
        delete process.env['PARLEY_CLAUDE_BIN'];
      }
    }, 40_000);
  });
});
