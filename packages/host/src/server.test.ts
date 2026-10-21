import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addSession, createWork, updateMap, workPaths } from '@parley/core';
import { BROWSER_AGENT_FEATURE, METHODS, NOTIFICATIONS, PROTOCOL_VERSION } from '@parley/protocol';
import type { SessionRef } from '@parley/protocol';
import { connectRaw, hello, removeHome, tempHome, waitClosed, waitConnected } from '../test/helpers.js';
import type { RawMessage, TestClient } from '../test/helpers.js';
import { startHost } from './host.js';
import type { RunningHost } from './host.js';
import { hostPaths } from './paths.js';
import { createHostServer, SLOW_REQUEST_MS } from './server.js';
import { HostError } from './errors.js';
import type { HostContext } from './context.js';

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
    for (const name of ['consents.list', 'consents.decide', 'trust.list', 'trust.grant', 'trust.revoke']) {
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
