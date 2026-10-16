import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { HostPaths } from '@parley/host';
import { encodeLine, LineDecoder, PROTOCOL_VERSION } from '@parley/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { S } from '../shared/strings.js';
import { HostConnection } from './host-connection.js';

interface FakeServerOptions {
  hostVersion?: string;
  protocolOk?: boolean;
  liveSessions?: number;
  /** Список методов в ответе `hello`; не задан — поля нет, как у хоста до этапа 3. */
  methods?: string[];
  /** События сразу после ответа `hello` — как повтор активности настоящего хоста. */
  afterHello?: unknown[];
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
      const decoder = new LineDecoder();
      socket.on('data', (chunk: Buffer) => {
        for (const raw of decoder.push(chunk)) {
          const message = raw as { id?: number; method?: string };
          if (message.method === 'hello' && typeof message.id === 'number') {
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
                  pid: process.pid,
                  ...(options.methods === undefined ? {} : { methods: options.methods }),
                },
              }),
            );
            for (const event of options.afterHello ?? []) socket.write(encodeLine(event));
            continue;
          }
          if (message.method === 'host.shutdown' && typeof message.id === 'number') {
            socket.write(encodeLine({ id: message.id, result: { ok: true } }));
            setTimeout(() => {
              socket.end();
              server.close();
            }, 10);
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
