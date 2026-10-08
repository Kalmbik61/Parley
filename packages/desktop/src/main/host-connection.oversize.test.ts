import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { HostPaths } from '@parley/host';
import { COMPACT_WORKS_FEATURE, encodeLine, LineDecoder, MAX_LINE_BYTES, PROTOCOL_VERSION } from '@parley/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { S } from '../shared/strings.js';
import { HostConnection } from './host-connection.js';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Fake {
  server: Server;
  /** Сколько соединений принял хост. */
  accepted: () => number;
  /** `hello.params` каждого соединения. */
  hellos: Array<Record<string, unknown>>;
  shutdowns: () => number;
}

/** Хост до P35: на `works.list` отвечает строкой длиннее предела кадра (две записи по 5 МиБ — одна строка). */
function startOversizeHost(paths: HostPaths): Promise<Fake> {
  let accepted = 0;
  let shutdowns = 0;
  const hellos: Fake['hellos'] = [];
  return new Promise((resolve, reject) => {
    const server = createServer((socket: Socket) => {
      accepted += 1;
      const decoder = new LineDecoder();
      socket.on('error', () => {});
      socket.on('data', (chunk: Buffer) => {
        for (const raw of decoder.push(chunk)) {
          const message = raw as { id?: number; method?: string; params?: Record<string, unknown> };
          if (typeof message.id !== 'number') continue;
          if (message.method === 'hello') {
            hellos.push(message.params ?? {});
            socket.write(encodeLine({ id: message.id, result: { hostVersion: '0.4.0', protocol: PROTOCOL_VERSION, pid: process.pid } }));
          } else if (message.method === 'works.list') {
            const huge = 'я'.repeat(MAX_LINE_BYTES / 2 + 10);
            socket.write(`${JSON.stringify({ id: message.id, result: { entries: [{ a: huge }, { b: huge }], branches: {} } })}\n`);
          } else if (message.method === 'host.shutdown') {
            shutdowns += 1;
            socket.write(encodeLine({ id: message.id, result: { ok: true } }));
            setTimeout(() => socket.end(), 10);
          }
        }
      });
    });
    rm(paths.socket, { force: true })
      .then(() => {
        server.once('error', reject);
        server.listen(paths.socket, () => resolve({ server, accepted: () => accepted, hellos, shutdowns: () => shutdowns }));
      })
      .catch(reject);
  });
}

describe('HostConnection: слишком длинная строка от хоста (P35)', () => {
  let home: string;
  let paths: HostPaths;
  let fakes: Fake[] = [];

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'hh-'));
    paths = {
      dir: path.join(home, 'host'),
      socket: path.join(home, 'host', 'host.sock'),
      token: path.join(home, 'host', 'host.token'),
      pid: path.join(home, 'host', 'host.pid'),
      log: path.join(home, 'host', 'host.log'),
    };
    await mkdir(paths.dir, { recursive: true });
    await writeFile(paths.token, 'test-token\n', 'utf8');
  });

  afterEach(async () => {
    for (const fake of fakes) fake.server.close();
    fakes = [];
    await rm(home, { recursive: true, force: true });
  });

  it('hello сообщает возможность compact-works', async () => {
    const fake = await startOversizeHost(paths);
    fakes.push(fake);
    const connection = new HostConnection({ paths, env: process.env, spawn: vi.fn(), connectTimeoutMs: 1000 });
    await connection.connect();
    expect(fake.hellos[0]?.['features']).toEqual([COMPACT_WORKS_FEATURE]);
    connection.close();
  });

  it('хост прислал строку длиннее предела: запрос отказывает с понятной причиной, статус называет действие, цикла переподключений нет', async () => {
    const fake = await startOversizeHost(paths);
    fakes.push(fake);
    const statuses: Array<{ state: string; reason?: string }> = [];
    const connection = new HostConnection({ paths, env: process.env, spawn: vi.fn(), connectTimeoutMs: 1000 });
    connection.onStatus((status) => statuses.push(status as { state: string; reason?: string }));
    await connection.connect();

    await expect(connection.call('works.list', {})).rejects.toThrow(S.connection.reasonOversize);
    expect(statuses.at(-1)).toEqual({ state: 'disconnected', reason: S.connection.reasonOversize });

    // Автоповтор начинается с 0,5 с: за три таких срока второго соединения быть не должно.
    await delay(1600);
    expect(fake.accepted()).toBe(1);
    expect(statuses.at(-1)).toEqual({ state: 'disconnected', reason: S.connection.reasonOversize });
    connection.close();
  }, 10_000);

  it('сокет остаётся, чтобы «Restart host» мог послать host.shutdown; закрытие хостом — обычное переподключение', async () => {
    const fake = await startOversizeHost(paths);
    fakes.push(fake);
    const statuses: Array<{ state: string }> = [];
    const connection = new HostConnection({ paths, env: process.env, spawn: vi.fn(), connectTimeoutMs: 3000 });
    connection.onStatus((status) => statuses.push(status));
    await connection.connect();
    await expect(connection.call('works.list', {})).rejects.toThrow();

    await connection.call('host.shutdown', {}).catch(() => undefined);
    await delay(300);
    expect(fake.shutdowns()).toBe(1);
    // Хост закрыл сокет — дальше обычное переподключение (хост в этом тесте прежний и снова принимает).
    await delay(1500);
    expect(fake.accepted()).toBeGreaterThan(1);
    expect(statuses.at(-1)?.state).toBe('connected');
    connection.close();
  }, 10_000);
});
