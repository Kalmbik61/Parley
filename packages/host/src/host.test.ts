import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { connectRaw, hello, removeHome, tempHome, waitConnected } from '../test/helpers.js';
import { HostAlreadyRunning, SocketPathTooLong, startHost } from './host.js';
import type { RunningHost } from './host.js';
import { hostPaths } from './paths.js';

const require = createRequire(import.meta.url);
const tsxLoader = pathToFileURL(require.resolve('tsx')).href;
const mainScript = fileURLToPath(new URL('./main.ts', import.meta.url));

let hosts: RunningHost[] = [];
let homes: string[] = [];

async function tempTrackedHome(): Promise<string> {
  const home = await tempHome();
  homes.push(home);
  return home;
}

afterEach(async () => {
  await Promise.all(hosts.map((h) => h.context.shutdown('test-cleanup').catch(() => {})));
  hosts = [];
  await Promise.all(homes.map((home) => removeHome(home)));
  homes = [];
});

describe('startHost', () => {
  it('создаёт каталог 0700, сокет 0600, токен 0600, pid с process.pid', async () => {
    const home = await tempTrackedHome();
    const running = await startHost({ home });
    hosts.push(running);
    const paths = hostPaths(home);

    const dirStat = await stat(paths.dir);
    expect(dirStat.mode & 0o777).toBe(0o700);
    const sockStat = await stat(paths.socket);
    expect(sockStat.mode & 0o777).toBe(0o600);
    const tokenStat = await stat(paths.token);
    expect(tokenStat.mode & 0o777).toBe(0o600);
    const pid = await readFile(paths.pid, 'utf8');
    expect(pid).toBe(String(process.pid));
  });

  it('второй startHost с тем же домом — HostAlreadyRunning, первый продолжает отвечать', async () => {
    const home = await tempTrackedHome();
    const running = await startHost({ home });
    hosts.push(running);

    await expect(startHost({ home })).rejects.toBeInstanceOf(HostAlreadyRunning);

    const paths = hostPaths(home);
    const token = await readFile(paths.token, 'utf8');
    const client = connectRaw(paths.socket);
    await waitConnected(client.socket);
    const response = await hello(client, token);
    expect(response.result).toMatchObject({ protocol: 1 });
    client.close();
  });

  it('остатки упавшего хоста: файл сокета без слушателя — новый хост стартует и отвечает', async () => {
    const home = await tempTrackedHome();
    const paths = hostPaths(home);
    // Как после SIGKILL: файлы остались, слушателя за ними уже нет.
    await mkdir(paths.dir, { recursive: true, mode: 0o700 });
    await writeFile(paths.socket, '');
    await writeFile(paths.pid, '999999');

    const running = await startHost({ home });
    hosts.push(running);

    const token = await readFile(paths.token, 'utf8');
    const client = connectRaw(paths.socket);
    await waitConnected(client.socket);
    const response = await hello(client, token);
    expect(response.result).toMatchObject({ protocol: 1 });
    client.close();
  });

  it('путь сокета длиннее 103 байт — SocketPathTooLong, каталог не создан', async () => {
    const longHome = `/tmp/hh-${'x'.repeat(150)}`;
    await expect(startHost({ home: longHome })).rejects.toBeInstanceOf(SocketPathTooLong);
    expect(existsSync(longHome)).toBe(false);
  });
});

describe('простой хоста', () => {
  it(
    'без клиентов хост уходит через idleMs',
    async () => {
      const home = await tempTrackedHome();
      const running = await startHost({ home, idleMs: 200 });
      hosts.push(running);

      const reason = await running.closed;
      expect(reason).toBe('idle');
      expect(existsSync(hostPaths(home).socket)).toBe(false);
    },
    5000,
  );

  it(
    'с подключённым клиентом хост живёт дольше idleMs',
    async () => {
      const home = await tempTrackedHome();
      const running = await startHost({ home, idleMs: 200 });
      hosts.push(running);
      const paths = hostPaths(home);
      const token = await readFile(paths.token, 'utf8');

      const client = connectRaw(paths.socket);
      await waitConnected(client.socket);
      await hello(client, token);

      let closed = false;
      void running.closed.then(() => {
        closed = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(closed).toBe(false);
      client.close();
    },
    5000,
  );
});

describe('процесс main.ts', () => {
  it(
    'tsx main.ts поднимает хост; SIGTERM убирает файлы; второй запуск при живом первом — код 3',
    async () => {
      const home = await tempTrackedHome();
      const paths = hostPaths(home);

      const first = spawn(process.execPath, ['--import', tsxLoader, mainScript], {
        env: { ...process.env, HARNAS_HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      try {
        await waitForFile(paths.pid, 10_000);

        const second = spawn(process.execPath, ['--import', tsxLoader, mainScript], {
          env: { ...process.env, HARNAS_HOME: home },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const [secondExit] = (await once(second, 'exit')) as [number | null];
        expect(secondExit).toBe(3);

        first.kill('SIGTERM');
        const [firstExit] = (await once(first, 'exit')) as [number | null];
        expect(firstExit).toBe(0);

        expect(existsSync(paths.socket)).toBe(false);
        expect(existsSync(paths.token)).toBe(false);
        expect(existsSync(paths.pid)).toBe(false);
      } finally {
        if (first.exitCode === null && first.signalCode === null) first.kill('SIGKILL');
      }
    },
    20_000,
  );
});

async function waitForFile(file: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!existsSync(file)) {
    if (Date.now() - start > timeoutMs) throw new Error(`файл не появился вовремя: ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
