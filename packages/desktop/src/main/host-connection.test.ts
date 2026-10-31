import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { HostPaths } from '@parley/host';
import { ASSISTANT_ACTIONS_FEATURE, BROWSER_AGENT_FEATURE, BROWSER_AGENT_OP_FEATURE, BROWSER_AGENT_OPS, COMPACT_WORKS_FEATURE, encodeLine, LineDecoder, PROTOCOL_VERSION, ROOMS_MAIL_FEATURE } from '@parley/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { S } from '../shared/strings.js';
import { answerBrowserAgentOps, HostConnection } from './host-connection.js';

interface FakeServerOptions {
  hostVersion?: string;
  protocolOk?: boolean;
  liveSessions?: number;
  /** Список методов в ответе `hello`; не задан — поля нет, как у хоста до этапа 3. */
  methods?: string[];
  /** События сразу после ответа `hello` — как повтор активности настоящего хоста. */
  afterHello?: unknown[];
  /** Всё, что клиент прислал: `hello`, вызовы методов (этап B2: что окно шлёт хосту). */
  received?: unknown[];
  /** pid в ответе `hello`; не задан — pid процесса теста. */
  pid?: number;
  /** На `host.shutdown` отвечает, но соединение не закрывает — зависший хост. */
  ignoreShutdown?: boolean;
  /** На `host.shutdown` не отвечает вовсе и соединение не закрывает — хост, чей цикл событий стоит. */
  shutdownHangs?: boolean;
  /** На `host.info` не отвечает вовсе. */
  infoHangs?: boolean;
  /** Подключения для управляемого выхода фейкового процесса. */
  sockets?: Socket[];
  /** Рукопожатие зависло, но shutdown хост ещё принимает. */
  helloHangs?: boolean;
}

/**
 * `HostConnection` тестируется против маленького протокольного сервера, а не
 * настоящего `@parley/host`: так тест не зависит от полного поведения хоста
 * (аренда работ, PTY и т. д.), которое проверяется в пакете host отдельно.
 * Понимает `hello` и `host.shutdown` — ровно то, что нужно для рукопожатия и
 * перезапуска.
 */
function startFakeServer(paths: HostPaths, options: FakeServerOptions = {}): Promise<Server> {
  const hostVersion = options.hostVersion ?? '0.0.0-test';
  const protocolOk = options.protocolOk ?? true;
  return new Promise((resolve, reject) => {
    const server = createServer((socket: Socket) => {
      options.sockets?.push(socket);
      socket.on('error', () => {});
      const decoder = new LineDecoder();
      socket.on('data', (chunk: Buffer) => {
        for (const raw of decoder.push(chunk)) {
          options.received?.push(raw);
          const message = raw as { id?: number; method?: string };
          if (message.method === 'hello' && typeof message.id === 'number') {
            if (options.helloHangs) continue;
            if (!protocolOk) {
              socket.write(
                encodeLine({
                  id: message.id,
                  error: {
                    code: 'protocol_mismatch',
                    message: 'протокол не совпадает',
                    data: { hostVersion, liveSessions: options.liveSessions ?? 0 },
                  },
                }),
              );
              socket.end();
              continue;
            }
            socket.write(
              encodeLine({
                id: message.id,
                result: {
                  hostVersion,
                  protocol: PROTOCOL_VERSION,
                  pid: options.pid ?? process.pid,
                  ...(options.methods === undefined ? {} : { methods: options.methods }),
                },
              }),
            );
            for (const event of options.afterHello ?? []) socket.write(encodeLine(event));
            continue;
          }
          if (message.method === 'host.shutdown' && typeof message.id === 'number') {
            if (options.shutdownHangs === true) continue;
            socket.write(encodeLine({ id: message.id, result: { ok: true } }));
            if (options.ignoreShutdown === true) continue;
            setTimeout(() => {
              socket.end();
              server.close();
            }, 10);
          }
          if (message.method === 'host.info' && typeof message.id === 'number' && options.infoHangs !== true) {
            socket.write(
              encodeLine({
                id: message.id,
                result: {
                  hostVersion,
                  pid: options.pid ?? process.pid,
                  startedAt: new Date().toISOString(),
                  clients: 1,
                  liveSessions: options.liveSessions ?? 0,
                },
              }),
            );
          }
          if (message.method === 'browser.agentResult' && typeof message.id === 'number') {
            socket.write(encodeLine({ id: message.id, result: { ok: true } }));
          }
        }
      });
    });
    // Как настоящий хост: снимаем висящий файл сокета перед listen (см. план,
    // кусок 1.3, шаг 3), иначе повторный запуск в том же временном доме упадёт
    // с EADDRINUSE.
    rm(paths.socket, { force: true })
      .then(() => {
        server.listen(paths.socket, () => resolve(server));
        server.once('error', reject);
      })
      .catch(reject);
  });
}

async function writeToken(paths: HostPaths): Promise<void> {
  await mkdir(paths.dir, { recursive: true });
  await writeFile(paths.token, 'test-token\n', 'utf8');
}

describe('HostConnection', () => {
  let home: string;
  let paths: HostPaths;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'hh-'));
    paths = {
      dir: path.join(home, 'host'),
      socket: path.join(home, 'host', 'host.sock'),
      token: path.join(home, 'host', 'host.token'),
      pid: path.join(home, 'host', 'host.pid'),
      log: path.join(home, 'host', 'host.log'),
    };
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('подключается к живому хосту без spawn', async () => {
    await writeToken(paths);
    const server = await startFakeServer(paths);
    const spawn = vi.fn();
    const connection = new HostConnection({ paths, env: process.env, spawn, connectTimeoutMs: 1000 });

    await connection.connect();

    expect(spawn).not.toHaveBeenCalled();
    connection.close();
    server.close();
  });

  it('без хоста зовёт spawn', async () => {
    await writeToken(paths);
    let server: Server | undefined;
    const spawn = vi.fn(() => {
      void startFakeServer(paths).then((s) => {
        server = s;
      });
      return null;
    });
    const connection = new HostConnection({ paths, env: process.env, spawn, connectTimeoutMs: 2000 });

    await connection.connect();

    expect(spawn).toHaveBeenCalledTimes(1);
    connection.close();
    server?.close();
  });

  it('файл сокета без слушателя → путь через spawn', async () => {
    await writeToken(paths);
    // Остаток упавшего хоста: сервер стартовал и сразу лёг, файл сокета остался.
    const dangling = await startFakeServer(paths);
    await new Promise<void>((resolve) => dangling.close(() => resolve()));

    let server: Server | undefined;
    const spawn = vi.fn(() => {
      void startFakeServer(paths).then((s) => {
        server = s;
      });
      return null;
    });
    const connection = new HostConnection({ paths, env: process.env, spawn, connectTimeoutMs: 2000 });

    await connection.connect();

    expect(spawn).toHaveBeenCalledTimes(1);
    connection.close();
    server?.close();
  }, 8000);

  it('на protocol_mismatch — статус mismatch', async () => {
    await writeToken(paths);
    const server = await startFakeServer(paths, { protocolOk: false, hostVersion: '9.9.9', liveSessions: 2 });
    const spawn = vi.fn();
    const statuses: unknown[] = [];
    const connection = new HostConnection({ paths, env: process.env, spawn, connectTimeoutMs: 1000 });
    connection.onStatus((status) => statuses.push(status));

    await connection.connect();

    expect(statuses.at(-1)).toEqual({ state: 'mismatch', hostVersion: '9.9.9', liveSessions: 2 });
    connection.close();
    server.close();
  });

  it('ответ hello без methods — methods: null, с methods — массив', async () => {
    await writeToken(paths);
    const old = await startFakeServer(paths, { hostVersion: '1.0.0' });
    const statuses: unknown[] = [];
    const first = new HostConnection({ paths, env: process.env, spawn: vi.fn(), connectTimeoutMs: 1000 });
    first.onStatus((status) => statuses.push(status));
    await first.connect();
    expect(statuses.at(-1)).toEqual({ state: 'connected', hostVersion: '1.0.0', methods: null, features: null });
    first.close();
    await new Promise<void>((resolve) => old.close(() => resolve()));

    const fresh = await startFakeServer(paths, { hostVersion: '2.0.0', methods: ['hello', 'works.rename'] });
    const second = new HostConnection({ paths, env: process.env, spawn: vi.fn(), connectTimeoutMs: 1000 });
    second.onStatus((status) => statuses.push(status));
    await second.connect();
    expect(statuses.at(-1)).toEqual({
      state: 'connected',
      hostVersion: '2.0.0',
      methods: ['hello', 'works.rename'],
      features: null,
    });
    second.close();
    fresh.close();
  });

  it('activity.changed до подписки окна копится по сессии; новое подключение начинает снимок заново', async () => {
    const activity = (sessionId: string, state: string): unknown => ({
      event: 'activity.changed',
      data: {
        ref: { projectPath: '/p', workId: 'w-0001', sessionId },
        activity: { activity: state },
        metrics: null,
      },
    });
    await writeToken(paths);
    let server = await startFakeServer(paths, {
      afterHello: [activity('s-1', 'idle'), activity('s-2', 'working'), activity('s-1', 'blocked')],
    });
    const spawn = vi.fn(() => {
      void startFakeServer(paths, { afterHello: [activity('s-2', 'idle')] }).then((s) => {
        server = s;
      });
    });
    const connection = new HostConnection({ paths, env: process.env, spawn, connectTimeoutMs: 2000 });
    // Слушателей событий нет — окно ещё не подписалось.
    await connection.connect();
    await vi.waitFor(() => expect(connection.activitySnapshot()).toHaveLength(2));
    const states = (): Record<string, string> =>
      Object.fromEntries(
        connection
          .activitySnapshot()
          .map((entry) => [entry.ref.sessionId, entry.activity.activity as string]),
      );
    expect(states()).toEqual({ 's-1': 'blocked', 's-2': 'working' });

    await connection.restartHost();
    await vi.waitFor(() => expect(states()).toEqual({ 's-2': 'idle' }));

    connection.close();
    server.close();
  }, 10000);

  it('host.notice до подписки окна копится на подключении; новое подключение начинает снимок заново', async () => {
    const notice = (text: string): unknown => ({
      event: 'host.notice',
      data: { kind: 'map-migration-failed', ref: null, text, at: '2026-10-24T00:00:00.000Z' },
    });
    await writeToken(paths);
    let server = await startFakeServer(paths, { afterHello: [notice('/a/map.json'), notice('/b/map.json')] });
    const spawn = vi.fn(() => {
      void startFakeServer(paths, { afterHello: [notice('/c/map.json')] }).then((s) => {
        server = s;
      });
    });
    const connection = new HostConnection({ paths, env: process.env, spawn, connectTimeoutMs: 2000 });
    // Слушателей событий нет — окно ещё не подписалось.
    await connection.connect();
    const texts = (): string[] => connection.noticesSnapshot().map((entry) => entry.text);
    await vi.waitFor(() => expect(texts()).toEqual(['/a/map.json', '/b/map.json']));

    await connection.restartHost();
    await vi.waitFor(() => expect(texts()).toEqual(['/c/map.json']));

    connection.close();
    server.close();
  }, 10000);

  it('снимок уведомлений хранит не больше 20 последних', async () => {
    const notices = Array.from({ length: 25 }, (_, index) => ({
      event: 'host.notice',
      data: { kind: 'map-migration-failed', ref: null, text: `/p${index}/map.json`, at: '2026-10-24T00:00:00.000Z' },
    }));
    await writeToken(paths);
    const server = await startFakeServer(paths, { afterHello: notices });
    const connection = new HostConnection({ paths, env: process.env, spawn: vi.fn(), connectTimeoutMs: 2000 });
    await connection.connect();

    await vi.waitFor(() => expect(connection.noticesSnapshot().at(-1)?.text).toBe('/p24/map.json'));
    expect(connection.noticesSnapshot()).toHaveLength(20);
    expect(connection.noticesSnapshot()[0]?.text).toBe('/p5/map.json');

    connection.close();
    server.close();
  });

  it('после host.shutdown переподключается к новому', async () => {
    await writeToken(paths);
    let server = await startFakeServer(paths);
    const spawn = vi.fn(() => {
      void startFakeServer(paths).then((s) => {
        server = s;
      });
      return null;
    });
    const connection = new HostConnection({ paths, env: process.env, spawn, connectTimeoutMs: 2000 });
    await connection.connect();
    expect(spawn).not.toHaveBeenCalled();

    await connection.call('host.shutdown', {});
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1), { timeout: 5000 });

    connection.close();
    server.close();
  }, 10000);
  it('токен читается до сокета: пока файла токена нет, соединений с хостом нет (lane-r3, п. 2)', async () => {
    // Хост закрывает соединение без hello через 5 с после accept: чтение токена после connect
    // тратило этот срок и под нагрузкой не укладывалось в него.
    await mkdir(paths.dir, { recursive: true });
    const server = await startFakeServer(paths);
    let accepted = 0;
    server.on('connection', () => {
      accepted += 1;
    });
    const connection = new HostConnection({ paths, env: process.env, spawn: vi.fn(), connectTimeoutMs: 3000 });
    const connecting = connection.connect();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const beforeToken = accepted;
    await writeToken(paths);
    await connecting;

    expect(beforeToken).toBe(0);
    expect(accepted).toBe(1);
    connection.close();
    server.close();
  }, 10000);

  it('медленный хост: сокет через 8 с после запуска, процесс жив — один запуск, связь есть (lane-r4, п. 2)', async () => {
    await writeToken(paths);
    let server: Server | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const spawn = vi.fn(() => {
      timer = setTimeout(() => {
        void startFakeServer(paths).then((s) => {
          server = s;
        });
      }, 8000);
      return { isRunning: () => true };
    });
    const connection = new HostConnection({ paths, env: process.env, spawn, connectTimeoutMs: 5000 });
    try {
      await connection.connect();
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      clearTimeout(timer);
      connection.close();
      server?.close();
    }
  }, 15000);

  it('запущенный процесс жив, а сокета нет дольше срока старта — отказ человеку, второго запуска нет (lane-r4, п. 2)', async () => {
    await writeToken(paths);
    const statuses: string[] = [];
    const spawn = vi.fn(() => ({ isRunning: () => true }));
    const connection = new HostConnection({ paths, env: process.env, spawn, connectTimeoutMs: 300, hostStartTimeoutMs: 800 });
    connection.onStatus((status) => {
      if (status.state === 'disconnected') statuses.push(status.reason);
    });
    await expect(connection.connect()).rejects.toThrow();
    expect(statuses.at(-1)).toBe(S.connection.reasonHostNotAnswering);
    // Повторная попытка (петля переподключения) при живом процессе хост не запускает.
    await expect(connection.restartHost()).rejects.toThrow();
    expect(spawn).toHaveBeenCalledTimes(1);
    connection.close();
  }, 10000);

  it('запущенный процесс вышел (например, код 3 — «уже запущен») — обычный срок, без ожидания старта (lane-r4, п. 2)', async () => {
    await writeToken(paths);
    const spawn = vi.fn(() => ({ isRunning: () => false }));
    const connection = new HostConnection({ paths, env: process.env, spawn, connectTimeoutMs: 300, hostStartTimeoutMs: 60_000 });
    const started = Date.now();
    await expect(connection.connect()).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5000);
    connection.close();
  }, 10000);

  it('прежний запущенный процесс ещё жив (уходит после host.shutdown) — новый запуск только после его выхода (lane-r4, п. 2)', async () => {
    await writeToken(paths);
    let running = true;
    let server: Server | undefined;
    const spawn = vi.fn(() => {
      // Первый запуск — процесс без сокета; второй поднимает сервер.
      if (spawn.mock.calls.length > 1) {
        void startFakeServer(paths).then((s) => {
          server = s;
        });
      }
      return { isRunning: () => running };
    });
    const connection = new HostConnection({ paths, env: process.env, spawn, connectTimeoutMs: 1000, hostStartTimeoutMs: 500 });
    await expect(connection.connect()).rejects.toThrow();
    expect(spawn).toHaveBeenCalledTimes(1);

    // Следующая попытка при живом процессе не запускает; процесс вышел — запуск в той же попытке.
    const retry = connection.connect();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(spawn).toHaveBeenCalledTimes(1);
    running = false;
    await retry;
    expect(spawn).toHaveBeenCalledTimes(2);
    connection.close();
    server?.close();
  }, 10000);

  it('обрыв посреди рукопожатия — одна петля, одно соединение, ввод доходит (lane-r4, п. 3)', async () => {
    await writeToken(paths);
    await mkdir(paths.dir, { recursive: true });
    // Первое соединение хост рвёт, не ответив на hello; следующие — обычное рукопожатие.
    const received: Array<{ connection: number; method: string }> = [];
    let accepted = 0;
    const server = createServer((socket: Socket) => {
      accepted += 1;
      const connection = accepted;
      const decoder = new LineDecoder();
      socket.on('data', (chunk: Buffer) => {
        for (const raw of decoder.push(chunk)) {
          const message = raw as { id?: number; method?: string };
          if (message.method === 'hello' && typeof message.id === 'number') {
            if (connection === 1) {
              socket.destroy();
              return;
            }
            socket.write(encodeLine({ id: message.id, result: { hostVersion: '0.0.0-test', protocol: PROTOCOL_VERSION, pid: process.pid } }));
            continue;
          }
          if (typeof message.method === 'string') received.push({ connection, method: message.method });
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(paths.socket, resolve));
    const connection = new HostConnection({ paths, env: process.env, spawn: vi.fn(() => null), connectTimeoutMs: 3000 });
    const states: string[] = [];
    connection.onStatus((status) => states.push(status.state));

    await connection.connect();
    // Петля переподключения (500 мс) успела бы завести третье соединение.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(accepted).toBe(2);
    expect(states.at(-1)).toBe('connected');
    // Рукопожатие не закончено — «нет связи» окну не показывается.
    expect(states).not.toContain('disconnected');

    connection.notify('pty.input', { ref: { projectPath: '/p', workId: 'w-1', sessionId: 's-01' }, data: 'a' });
    await vi.waitFor(() => expect(received).toEqual([{ connection: 2, method: 'pty.input' }]));
    connection.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }, 10000);

  it('notify без связи — не молча: предупреждение в консоли main со счётчиком (lane-r3, п. 2)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const connection = new HostConnection({ paths, env: process.env, spawn: vi.fn(), connectTimeoutMs: 1000 });
    const ref = { projectPath: '/p', workId: 'w-1', sessionId: 's-01' };

    expect(() => connection.notify('pty.input', { ref, data: 'a' })).not.toThrow();
    connection.notify('pty.input', { ref, data: 'b' });

    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0]?.[0])).toContain('pty.input');
    expect(String(warn.mock.calls[1]?.[0])).toContain('2');
    warn.mockRestore();
  });

  it('неудачный первый connect — повторы идут сами; хост появился — окно подключается (fix-final-b, M4)', async () => {
    await writeToken(paths);
    const statuses: string[] = [];
    // Хост не поднимается: запуск ничего не даёт, процесса нет.
    const spawn = vi.fn(() => null);
    const connection = new HostConnection({ paths, env: process.env, spawn, connectTimeoutMs: 300 });
    connection.onStatus((status) => statuses.push(status.state));
    await expect(connection.connect()).rejects.toThrow();
    expect(statuses.at(-1)).toBe('disconnected');

    // Хост появился позже (человек поднял его, прошлый запуск дошёл) — петля сама подключается.
    const server = await startFakeServer(paths);
    try {
      await vi.waitFor(() => expect(statuses.at(-1)).toBe('connected'), { timeout: 5000 });
    } finally {
      connection.close();
      server.close();
    }
  }, 10000);

  it('неудачный restartHost — переподключение заведено: новый хост позже — связь есть (fix-final-b, M4)', async () => {
    await writeToken(paths);
    let server = await startFakeServer(paths);
    const statuses: string[] = [];
    const spawn = vi.fn(() => null);
    const connection = new HostConnection({ paths, env: process.env, spawn, connectTimeoutMs: 300 });
    await connection.connect();
    connection.onStatus((status) => statuses.push(status.state));

    // Старый хост ушёл, новый не поднялся в срок — restartHost отказал.
    await expect(connection.restartHost()).rejects.toThrow();
    expect(statuses.at(-1)).toBe('disconnected');

    server = await startFakeServer(paths);
    try {
      await vi.waitFor(() => expect(statuses.at(-1)).toBe('connected'), { timeout: 5000 });
    } finally {
      connection.close();
      server.close();
    }
  }, 10000);

  it('recentCalls: успешный вызов записан с методом, ok и числовым ms', async () => {
    await writeToken(paths);
    const server = await startFakeServer(paths);
    const connection = new HostConnection({ paths, env: process.env, spawn: vi.fn(() => null), connectTimeoutMs: 1000 });
    await connection.connect();
    expect(connection.recentCalls()).toEqual([]);

    await connection.call('host.shutdown', {});

    const calls = connection.recentCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'host.shutdown', ok: true });
    expect(typeof calls[0]?.ms).toBe('number');
    expect(calls[0]?.ms).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(Date.parse(calls[0]?.t ?? ''))).toBe(false);
    expect(calls[0]).not.toHaveProperty('error');
    expect(calls[0]).not.toHaveProperty('ref');

    connection.close();
    server.close();
  });

  it('recentCalls: вызов без ответа, отклонённый при закрытии соединения, записан с ok: false и ref', async () => {
    await writeToken(paths);
    const server = await startFakeServer(paths);
    const connection = new HostConnection({ paths, env: process.env, spawn: vi.fn(() => null), connectTimeoutMs: 1000 });
    await connection.connect();

    // Фейковый хост на pty.send не отвечает; host.shutdown следом закроет сокет, и handleClose отклонит ждущий вызов.
    const hanging = connection.call('pty.send', { ref: { projectPath: '/p', workId: 'w-1', sessionId: 's-7' }, text: 'x', submit: true });
    const rejection = expect(hanging).rejects.toThrow(S.connection.reasonClosed);
    await connection.call('host.shutdown', {});
    await rejection;

    const calls = connection.recentCalls();
    expect(calls.map((c) => [c.method, c.ok])).toEqual([
      ['host.shutdown', true],
      ['pty.send', false],
    ]);
    expect(calls[1]).toMatchObject({ ref: 's-7', error: S.connection.reasonClosed.slice(0, 120) });
    expect(typeof calls[1]?.ms).toBe('number');

    connection.close();
    server.close();
  });

  it('recentCalls: вызов без соединения записан с error no-connection', async () => {
    const connection = new HostConnection({ paths, env: process.env, spawn: vi.fn(() => null), connectTimeoutMs: 1000 });

    await expect(
      connection.call('pty.send', { ref: { projectPath: '/p', workId: 'w-1', sessionId: 's-3' }, text: 'x', submit: true }),
    ).rejects.toThrow('no connection to host');

    const calls = connection.recentCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'pty.send', ms: 0, ok: false, error: 'no-connection', ref: 's-3' });
    expect(Number.isNaN(Date.parse(calls[0]?.t ?? ''))).toBe(false);
  });

  it('recentCalls: висящий вызов виден как pending с возрастом, после закрытия — как обычный отказ', async () => {
    await writeToken(paths);
    const server = await startFakeServer(paths);
    const connection = new HostConnection({ paths, env: process.env, spawn: vi.fn(() => null), connectTimeoutMs: 1000 });
    await connection.connect();

    // Фейковый хост на pty.send не отвечает.
    const hanging = connection.call('pty.send', { ref: { projectPath: '/p', workId: 'w-1', sessionId: 's-9' }, text: 'x', submit: true });
    const rejection = expect(hanging).rejects.toThrow(S.connection.reasonClosed);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const calls = connection.recentCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'pty.send', ok: false, error: 'pending', ref: 's-9' });
    expect(calls[0]?.ms).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(Date.parse(calls[0]?.t ?? ''))).toBe(false);

    // host.shutdown закроет сокет, и handleClose отклонит ждущий вызов: висящих больше нет.
    await connection.call('host.shutdown', {});
    await rejection;
    expect(connection.recentCalls().map((c) => c.error)).not.toContain('pending');

    connection.close();
    server.close();
  });

  it('после close повторов нет: неудачный connect и close — хост позже не подключается (fix-final-b, M4)', async () => {
    await writeToken(paths);
    const connection = new HostConnection({ paths, env: process.env, spawn: vi.fn(() => null), connectTimeoutMs: 300 });
    await expect(connection.connect()).rejects.toThrow();
    connection.close();

    const server = await startFakeServer(paths);
    let accepted = 0;
    server.on('connection', () => {
      accepted += 1;
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(accepted).toBe(0);
    server.close();
  }, 10000);
});

describe('операции агента над браузером (этап B2, спека браузера 3.7)', () => {
  let home: string;
  let paths: HostPaths;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'hh-'));
    paths = {
      dir: path.join(home, 'host'),
      socket: path.join(home, 'host', 'host.sock'),
      token: path.join(home, 'host', 'host.token'),
      pid: path.join(home, 'host', 'host.pid'),
      log: path.join(home, 'host', 'host.log'),
    };
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const op = (opId: string) => ({
    event: 'browser.agentOp',
    data: { opId, ref: { projectPath: '/p', workId: 'w-1', sessionId: 's-02' }, label: 'S02', op: 'open', args: { url: 'http://localhost:5173/' } },
  });

  it('hello заявляет compact-works, rooms-mail, browser-agent, browser-agent:<op> на каждую операцию и assistant-actions', async () => {
    await writeToken(paths);
    const received: unknown[] = [];
    const server = await startFakeServer(paths, { received });
    const connection = new HostConnection({ paths, env: process.env, spawn: vi.fn(), connectTimeoutMs: 1000 });
    await connection.connect();
    const hello = received.find((message) => (message as { method?: string }).method === 'hello') as { params: { features: string[] } };
    expect(hello.params.features).toEqual([COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE, BROWSER_AGENT_FEATURE, ...BROWSER_AGENT_OPS.map(BROWSER_AGENT_OP_FEATURE), ASSISTANT_ACTIONS_FEATURE]);
    connection.close();
    server.close();
  });

  it('операция агента уходит в run, ответ — browser.agentResult с тем же opId; сбой run — unsupported', async () => {
    await writeToken(paths);
    const received: unknown[] = [];
    const server = await startFakeServer(paths, { received, afterHello: [op('op-1'), op('op-2')] });
    const connection = new HostConnection({ paths, env: process.env, spawn: vi.fn(), connectTimeoutMs: 1000 });
    answerBrowserAgentOps(connection, async (event) => {
      if (event.opId === 'op-2') throw new Error('boom');
      return { ok: true, result: { tab: 't1', url: 'http://localhost:5173/', reused: false, notes: [] } };
    });
    await connection.connect();
    const results = (): unknown[] =>
      received.filter((message) => (message as { method?: string }).method === 'browser.agentResult').map((message) => (message as { params: unknown }).params);
    await vi.waitFor(() => expect(results()).toHaveLength(2));
    expect(results()).toEqual(
      expect.arrayContaining([
        { opId: 'op-1', ok: true, result: { tab: 't1', url: 'http://localhost:5173/', reused: false, notes: [] } },
        { opId: 'op-2', ok: false, error: { code: 'unsupported', message: 'boom' } },
      ]),
    );
    await vi.waitFor(() => expect(connection.recentCalls().filter((call) => call.error === 'pending')).toEqual([]));
    connection.close();
    server.close();
  });

  it('прочие события run не получают; отписка снимает слушателя', async () => {
    await writeToken(paths);
    const server = await startFakeServer(paths, { afterHello: [{ event: 'wake.changed', data: { paused: true } }] });
    const connection = new HostConnection({ paths, env: process.env, spawn: vi.fn(), connectTimeoutMs: 1000 });
    const run = vi.fn(async () => ({ ok: true as const, result: null }));
    const off = answerBrowserAgentOps(connection, run);
    await connection.connect();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(run).not.toHaveBeenCalled();
    off();
    connection.close();
    server.close();
  });
});

/**
 * Выход из приложения гасит хост (решение 2026-10-16): `stopHost` останавливает хост насовсем — без нового запуска и
 * переподключения; хост завис — добивается по pid (SIGTERM, затем SIGKILL). Процессы — через подменяемый `processes`:
 * pid в тестах вымышленный, сигналы настоящим процессам не уходят.
 */
describe('HostConnection: остановка хоста при выходе', () => {
  let home: string;
  let paths: HostPaths;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'hq-'));
    paths = {
      dir: path.join(home, 'host'),
      socket: path.join(home, 'host', 'host.sock'),
      token: path.join(home, 'host', 'host.token'),
      pid: path.join(home, 'host', 'host.pid'),
      log: path.join(home, 'host', 'host.log'),
    };
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  /** Процессы-заглушки: `alive` решает, жив ли pid; сигналы — в журнал. */
  function fakeProcesses(alive: (pid: number) => boolean, isHost: (pid: number) => boolean = () => true) {
    const signals: Array<[number, string]> = [];
    return {
      signals,
      processes: {
        kill: vi.fn((pid: number, signal: NodeJS.Signals) => {
          signals.push([pid, signal]);
        }),
        isAlive: vi.fn(alive),
        isHost: vi.fn(isHost),
      },
    };
  }

  const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('хост вышел по host.shutdown — «shutdown», сигналов нет; окно не переподключается и хост не поднимает', async () => {
    await writeToken(paths);
    const server = await startFakeServer(paths, { pid: 999_001 });
    const spawn = vi.fn();
    const { processes, signals } = fakeProcesses(() => false);
    const connection = new HostConnection({ paths, env: process.env, spawn, connectTimeoutMs: 1000, processes });
    await connection.connect();

    await expect(connection.stopHost({ timeoutMs: 1000, killGraceMs: 100 })).resolves.toBe('shutdown');
    // Дольше первой паузы переподключения (0,5 с): петля не должна ожить.
    await settle(1200);
    expect(spawn).not.toHaveBeenCalled();
    expect(signals).toEqual([]);
    connection.close();
    server.close();
  }, 10_000);

  it('хост не закрылся за срок — SIGTERM по pid из hello; жив и дальше — SIGKILL: «killed»', async () => {
    await writeToken(paths);
    const server = await startFakeServer(paths, { pid: 999_002, ignoreShutdown: true });
    const { processes, signals } = fakeProcesses(() => true);
    const connection = new HostConnection({ paths, env: process.env, spawn: vi.fn(), connectTimeoutMs: 1000, processes });
    await connection.connect();

    await expect(connection.stopHost({ timeoutMs: 200, killGraceMs: 100 })).resolves.toBe('killed');
    expect(signals).toEqual([
      [999_002, 'SIGTERM'],
      [999_002, 'SIGKILL'],
    ]);
    connection.close();
    server.close();
  }, 10_000);

  it('хост не отвечает на host.shutdown вовсе — срок всё равно выходит, хост добивается по pid', async () => {
    await writeToken(paths);
    const server = await startFakeServer(paths, { pid: 999_008, shutdownHangs: true });
    const { processes, signals } = fakeProcesses(() => true);
    const connection = new HostConnection({ paths, env: process.env, spawn: vi.fn(), connectTimeoutMs: 1000, processes });
    await connection.connect();

    const started = Date.now();
    await expect(connection.stopHost({ timeoutMs: 200, killGraceMs: 100 })).resolves.toBe('killed');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(signals).toEqual([
      [999_008, 'SIGTERM'],
      [999_008, 'SIGKILL'],
    ]);
    connection.close();
    server.close();
  }, 10_000);

  it('SIGTERM хватило — SIGKILL не шлётся', async () => {
    await writeToken(paths);
    const server = await startFakeServer(paths, { pid: 999_003, ignoreShutdown: true });
    let terminated = false;
    const { processes, signals } = fakeProcesses(() => !terminated);
    processes.kill.mockImplementation((pid: number, signal: NodeJS.Signals) => {
      signals.push([pid, signal]);
      if (signal === 'SIGTERM') terminated = true;
    });
    const connection = new HostConnection({ paths, env: process.env, spawn: vi.fn(), connectTimeoutMs: 1000, processes });
    await connection.connect();

    await expect(connection.stopHost({ timeoutMs: 200, killGraceMs: 100 })).resolves.toBe('killed');
    expect(signals).toEqual([[999_003, 'SIGTERM']]);
    connection.close();
    server.close();
  }, 10_000);

  it('связи нет: живой хост по host.pid гасится по pid; чужой процесс под тем же pid не трогается', async () => {
    await mkdir(paths.dir, { recursive: true });
    await writeFile(paths.pid, `999004\n${new Date().toISOString()}\n`, 'utf8');
    let terminated = false;
    const { processes, signals } = fakeProcesses(() => !terminated);
    processes.kill.mockImplementation((pid: number, signal: NodeJS.Signals) => {
      signals.push([pid, signal]);
      terminated = true;
    });
    const spawn = vi.fn();
    const connection = new HostConnection({ paths, env: process.env, spawn, connectTimeoutMs: 300, processes });

    await expect(connection.stopHost({ timeoutMs: 200, killGraceMs: 100 })).resolves.toBe('killed');
    expect(signals).toEqual([[999_004, 'SIGTERM']]);
    expect(spawn).not.toHaveBeenCalled();

    const foreign = fakeProcesses(() => true, () => false);
    const other = new HostConnection({ paths, env: process.env, spawn, connectTimeoutMs: 300, processes: foreign.processes });
    await expect(other.stopHost({ timeoutMs: 200, killGraceMs: 100 })).resolves.toBe('none');
    expect(foreign.signals).toEqual([]);
  }, 10_000);

  it('связи нет и pid-файла нет — «none», сигналов нет', async () => {
    const { processes, signals } = fakeProcesses(() => true);
    const connection = new HostConnection({ paths, env: process.env, spawn: vi.fn(), connectTimeoutMs: 300, processes });
    await expect(connection.stopHost({ timeoutMs: 200, killGraceMs: 100 })).resolves.toBe('none');
    expect(signals).toEqual([]);
  });

  it('liveSessions: связь есть — число из host.info; host.info молчит — null по сроку', async () => {
    await writeToken(paths);
    const server = await startFakeServer(paths, { pid: 999_005, liveSessions: 18 });
    const { processes } = fakeProcesses(() => true);
    const connection = new HostConnection({ paths, env: process.env, spawn: vi.fn(), connectTimeoutMs: 1000, processes });
    await connection.connect();
    await expect(connection.liveSessions(500)).resolves.toBe(18);
    connection.close();
    server.close();

    await writeToken(paths);
    const silent = await startFakeServer(paths, { pid: 999_006, infoHangs: true });
    const second = new HostConnection({ paths, env: process.env, spawn: vi.fn(), connectTimeoutMs: 1000, processes });
    await second.connect();
    const started = Date.now();
    await expect(second.liveSessions(200)).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
    second.close();
    silent.close();
  }, 10_000);

  it('liveSessions без связи: хоста нет — 0; живой хост по host.pid — null (не знаем, сколько)', async () => {
    const none = fakeProcesses(() => false);
    const connection = new HostConnection({ paths, env: process.env, spawn: vi.fn(), connectTimeoutMs: 300, processes: none.processes });
    await expect(connection.liveSessions(200)).resolves.toBe(0);

    await mkdir(paths.dir, { recursive: true });
    await writeFile(paths.pid, `999007\n${new Date().toISOString()}\n`, 'utf8');
    const alive = fakeProcesses(() => true);
    const other = new HostConnection({ paths, env: process.env, spawn: vi.fn(), connectTimeoutMs: 300, processes: alive.processes });
    await expect(other.liveSessions(200)).resolves.toBeNull();
  });
});

/** Короткие сроки и вымышленные pid: проверяем остановку, не посылая сигналы процессам машины. */
describe('HostConnection: ограниченный Restart Host', () => {
  let home: string;
  let paths: HostPaths;
  let connection: HostConnection;
  let servers: Server[];
  let sockets: Socket[];
  const deadlines = { timeoutMs: 60, killGraceMs: 40, killWaitMs: 40 };
  const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'hr-'));
    paths = {
      dir: path.join(home, 'host'), socket: path.join(home, 'host', 'host.sock'),
      token: path.join(home, 'host', 'host.token'), pid: path.join(home, 'host', 'host.pid'),
      log: path.join(home, 'host', 'host.log'),
    };
    servers = [];
    sockets = [];
    await writeToken(paths);
  });

  afterEach(async () => {
    connection?.close();
    for (const socket of sockets) socket.destroy();
    for (const server of servers) server.close();
    await rm(home, { recursive: true, force: true });
  });

  async function host(options: FakeServerOptions = {}) {
    const server = await startFakeServer(paths, { ...options, sockets });
    servers.push(server);
    return server;
  }

  function processes() {
    let alive = true;
    let isHost = true;
    const signals: NodeJS.Signals[] = [];
    return {
      signals,
      exit() {
        alive = false;
        for (const socket of sockets) socket.destroy();
        for (const server of servers) server.close();
      },
      foreign() { isHost = false; },
      hooks: {
        isAlive: vi.fn(() => alive),
        isHost: vi.fn(() => isHost),
        kill: vi.fn((_pid: number, signal: NodeJS.Signals) => { signals.push(signal); }),
      },
    };
  }

  function replacement(proc: ReturnType<typeof processes>) {
    return vi.fn(async () => {
      expect(proc.hooks.isAlive()).toBe(false);
      await host({ pid: 999_202 });
      return null;
    });
  }

  it('молчащий shutdown: TERM, KILL, подтверждённый выход и ровно одно новое подключение', async () => {
    const received: unknown[] = [];
    await host({ pid: 999_201, shutdownHangs: true, received });
    const proc = processes();
    proc.hooks.kill.mockImplementation((_pid, signal) => {
      proc.signals.push(signal);
      if (signal === 'SIGKILL') proc.exit();
    });
    const spawn = replacement(proc);
    connection = new HostConnection({ paths, env: process.env, spawn, processes: proc.hooks, connectTimeoutMs: 500 });
    await connection.connect();
    const pending = connection.call('pty.send', {}).catch((error: Error) => error);
    const started = Date.now();
    const first = connection.restartHost(deadlines);
    const second = connection.restartHost(deadlines);
    expect(second).toBe(first);
    await Promise.all([first, connection.connect()]);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(proc.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(proc.hooks.kill.mock.calls).toEqual([[999_201, 'SIGTERM'], [999_201, 'SIGKILL']]);
    expect(received.filter((raw) => (raw as { method: string }).method === 'host.shutdown')).toHaveLength(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(await pending).toBeInstanceOf(Error);
    expect(connection.recentCalls().filter((call) => call.error === 'pending')).toEqual([]);
  });

  it.each(['reply', 'socket'] as const)('одного %s недостаточно: живой старый pid после KILL даёт ограниченный отказ', async (mode) => {
    await host({ pid: 999_201, ignoreShutdown: mode === 'reply' });
    const proc = processes();
    const spawn = vi.fn();
    connection = new HostConnection({ paths, env: process.env, spawn, processes: proc.hooks, connectTimeoutMs: 500 });
    await connection.connect();
    const started = Date.now();
    await expect(connection.restartHost(deadlines)).rejects.toThrow(/exit|teardown/i);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(proc.signals).toEqual(['SIGTERM', 'SIGKILL']);
    await settle(600);
    expect(spawn).not.toHaveBeenCalled();
    expect(connection.recentCalls().filter((call) => call.error === 'pending')).toEqual([]);
  });

  it.each(['graceful', 'term'] as const)('%s: после подтверждённого выхода лишних сигналов нет', async (mode) => {
    await host({ pid: 999_201, shutdownHangs: true });
    const proc = processes();
    proc.hooks.kill.mockImplementation((_pid, signal) => { proc.signals.push(signal); proc.exit(); });
    const spawn = replacement(proc);
    connection = new HostConnection({ paths, env: process.env, spawn, processes: proc.hooks, connectTimeoutMs: 500 });
    await connection.connect();
    const timer = mode === 'graceful' ? setTimeout(() => proc.exit(), 20) : undefined;
    try { await connection.restartHost(deadlines); } finally { clearTimeout(timer); }
    expect(proc.signals).toEqual(mode === 'term' ? ['SIGTERM'] : []);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it.each(['close', 'stop'] as const)('%s во время teardown отменяет restart без нового процесса', async (mode) => {
    await host({ pid: 999_201, shutdownHangs: true });
    const proc = processes();
    const spawn = vi.fn();
    connection = new HostConnection({ paths, env: process.env, spawn, processes: proc.hooks, connectTimeoutMs: 500 });
    await connection.connect();
    const restart = connection.restartHost(deadlines);
    const rejected = expect(restart).rejects.toThrow();
    if (mode === 'close') connection.close();
    else await connection.stopHost({ timeoutMs: 20, killGraceMs: 20 });
    await rejected;
    await settle(600);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('restart во время зависшего hello: старое рукопожатие отменено, shutdown отправлен, второго spawn нет', async () => {
    const received: unknown[] = [];
    await host({ helloHangs: true, received });
    const spawn = vi.fn(async () => { await host(); return null; });
    connection = new HostConnection({ paths, env: process.env, spawn, connectTimeoutMs: 500 });
    const connecting = connection.connect().catch((error: Error) => error);
    await vi.waitFor(() => expect(received).toHaveLength(1));
    await connection.restartHost(deadlines);
    expect(await connecting).toBeInstanceOf(Error);
    expect(received.filter((raw) => (raw as { method: string }).method === 'host.shutdown')).toHaveLength(1);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('restart при незавершённом spawn ограниченно отказывает, поздний результат не запускает новую петлю', async () => {
    let finish!: (host: null) => void;
    const spawn = vi.fn(() => new Promise<null>((resolve) => { finish = resolve; }));
    connection = new HostConnection({ paths, env: process.env, spawn, connectTimeoutMs: 200 });
    const connecting = connection.connect().catch((error: Error) => error);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    const started = Date.now();
    await expect(connection.restartHost(deadlines)).rejects.toThrow(/pending spawn/);
    expect(Date.now() - started).toBeLessThan(2000);
    finish(null);
    expect(await connecting).toBeInstanceOf(Error);
    await settle(600);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(connection.recentCalls().filter((call) => call.error === 'pending')).toEqual([]);
  });

  it.each(['SIGTERM', 'SIGKILL'] as const)('pid перешёл чужому процессу перед %s: этот сигнал не отправляется', async (signalToSkip) => {
    await host({ pid: 999_201, shutdownHangs: true });
    const proc = processes();
    const replacePid = () => {
      proc.foreign();
      for (const socket of sockets) socket.destroy();
      for (const server of servers) server.close();
    };
    proc.hooks.kill.mockImplementation((_pid, signal) => { proc.signals.push(signal); replacePid(); });
    const spawn = vi.fn(async () => { await host(); return null; });
    connection = new HostConnection({ paths, env: process.env, spawn, processes: proc.hooks, connectTimeoutMs: 500 });
    await connection.connect();
    const timer = signalToSkip === 'SIGTERM' ? setTimeout(replacePid, 20) : undefined;
    try { await connection.restartHost(deadlines); } finally { clearTimeout(timer); }
    expect(proc.signals).toEqual(signalToSkip === 'SIGTERM' ? [] : ['SIGTERM']);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('неизвестный/чужой pid и открытый сокет: ограниченный отказ без сигналов и автоповтора', async () => {
    const received: unknown[] = [];
    await host({ pid: 999_201, shutdownHangs: true, received });
    const proc = processes();
    proc.foreign();
    const spawn = vi.fn();
    connection = new HostConnection({ paths, env: process.env, spawn, processes: proc.hooks, connectTimeoutMs: 500 });
    await connection.connect();
    await expect(connection.restartHost(deadlines)).rejects.toThrow(/without a host PID/);
    await expect(connection.connect()).rejects.toThrow(/unresolved/);
    // Собственное destroy после отказа не превращается в доказательство выхода при следующем restart.
    await expect(connection.restartHost(deadlines)).rejects.toThrow(/without a host PID/);
    await settle(600);
    expect(proc.signals).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
    expect(received.filter((raw) => (raw as { method: string }).method === 'hello')).toHaveLength(1);
  });

  it.each(['mismatch', 'foreign-hello'] as const)('%s: только проверенный pid-файл используется для сигналов', async (mode) => {
    await host({ pid: 999_299, protocolOk: mode !== 'mismatch', shutdownHangs: true });
    await writeFile(paths.pid, '999201\n2026-10-30T00:00:00.000Z\n');
    const proc = processes();
    proc.hooks.isHost.mockImplementation((pid?: number) => pid === 999_201);
    proc.hooks.kill.mockImplementation((_pid, signal) => { proc.signals.push(signal); proc.exit(); });
    const spawn = replacement(proc);
    connection = new HostConnection({ paths, env: process.env, spawn, processes: proc.hooks, connectTimeoutMs: 500 });
    await connection.connect();
    await connection.restartHost(deadlines);
    expect(proc.hooks.kill).toHaveBeenCalledTimes(1);
    expect(proc.hooks.kill).toHaveBeenCalledWith(999_201, 'SIGTERM');
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('после отказа старый pid не забыт: следующий restart снова проверяет его и может завершиться', async () => {
    await host({ pid: 999_201, shutdownHangs: true });
    const proc = processes();
    const spawn = replacement(proc);
    connection = new HostConnection({ paths, env: process.env, spawn, processes: proc.hooks, connectTimeoutMs: 500 });
    await connection.connect();
    await expect(connection.restartHost(deadlines)).rejects.toThrow(/did not exit/);
    proc.hooks.kill.mockImplementation((_pid, signal) => { proc.signals.push(signal); proc.exit(); });
    await connection.restartHost(deadlines);
    expect(proc.signals).toEqual(['SIGTERM', 'SIGKILL', 'SIGTERM']);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it.each(['close', 'stop'] as const)('%s во время нового hello запрещает позднее подключение и автоповтор', async (mode) => {
    const received: unknown[] = [];
    await host({ pid: 999_201, shutdownHangs: true });
    const proc = processes();
    proc.hooks.kill.mockImplementation((_pid, signal) => { proc.signals.push(signal); proc.exit(); });
    const spawn = vi.fn(async () => { await host({ helloHangs: true, received }); return null; });
    const statuses: string[] = [];
    connection = new HostConnection({ paths, env: process.env, spawn, processes: proc.hooks, connectTimeoutMs: 500 });
    await connection.connect();
    const restart = connection.restartHost(deadlines);
    const rejected = expect(restart).rejects.toThrow();
    await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 2000 });
    connection.onStatus((status) => statuses.push(status.state));
    if (mode === 'close') connection.close();
    else await connection.stopHost({ timeoutMs: 20, killGraceMs: 20 });
    await rejected;
    await settle(600);
    expect(statuses).not.toContain('connected');
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(connection.recentCalls().filter((call) => call.error === 'pending')).toEqual([]);
  });
});
