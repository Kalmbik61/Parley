import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { HostPaths } from '@harnas/host';
import { encodeLine, LineDecoder, PROTOCOL_VERSION } from '@harnas/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostConnection } from './host-connection.js';

interface FakeServerOptions {
  hostVersion?: string;
  protocolOk?: boolean;
  liveSessions?: number;
}

/**
 * `HostConnection` тестируется против маленького протокольного сервера, а не
 * настоящего `@harnas/host`: так тест не зависит от полного поведения хоста
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
              encodeLine({ id: message.id, result: { hostVersion, protocol: PROTOCOL_VERSION, pid: process.pid } }),
            );
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

  it('после host.shutdown переподключается к новому', async () => {
    await writeToken(paths);
    let server = await startFakeServer(paths);
    const spawn = vi.fn(() => {
      void startFakeServer(paths).then((s) => {
        server = s;
      });
    });
    const connection = new HostConnection({ paths, env: process.env, spawn, connectTimeoutMs: 2000 });
    await connection.connect();
    expect(spawn).not.toHaveBeenCalled();

    await connection.call('host.shutdown', {});
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1), { timeout: 5000 });

    connection.close();
    server.close();
  }, 10000);
});
