import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { uptime } from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { connectRaw, hello, removeHome, tempHome, waitConnected } from '../test/helpers.js';
import { processStartedAt } from '@parley/core';
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
    expect(lockPid(pid)).toBe(process.pid);
  });

  it('дом уходит в окружение под обоими именами (R3), а на остановке окружение возвращается прежним', async () => {
    const before = { parley: process.env.PARLEY_HOME, harnas: process.env.HARNAS_HOME };
    delete process.env.PARLEY_HOME;
    process.env.HARNAS_HOME = '/прежний/дом';
    try {
      const home = await tempTrackedHome();
      const running = await startHost({ home });
      hosts.push(running);

      // Агенты и скрипты, которых хост запускает, наследуют его окружение: новые читают PARLEY_HOME, старые — HARNAS_HOME.
      expect(process.env.PARLEY_HOME).toBe(home);
      expect(process.env.HARNAS_HOME).toBe(home);

      await running.context.shutdown('test');
      await running.closed;
      expect(process.env.PARLEY_HOME).toBeUndefined();
      expect(process.env.HARNAS_HOME).toBe('/прежний/дом');
    } finally {
      for (const [name, value] of [
        ['PARLEY_HOME', before.parley],
        ['HARNAS_HOME', before.harnas],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it('отказ второго хоста (HostAlreadyRunning) оставляет окружение первого нетронутым', async () => {
    const home = await tempTrackedHome();
    const running = await startHost({ home });
    hosts.push(running);

    await expect(startHost({ home })).rejects.toBeInstanceOf(HostAlreadyRunning);

    expect(process.env.PARLEY_HOME).toBe(home);
    expect(process.env.HARNAS_HOME).toBe(home);
  });

  // Строка статуса окна — `Host <версия из hello>`: без явной версии хост называет ту, что в его package.json.
  it('hello без заданной версии отдаёт version из package.json хоста; заданная — как есть', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    const versions: string[] = [];
    for (const options of [{}, { version: '9.8.7' }]) {
      const home = await tempTrackedHome();
      const running = await startHost({ home, ...options });
      hosts.push(running);
      const paths = hostPaths(home);
      const client = connectRaw(paths.socket);
      await waitConnected(client.socket);
      const response = await hello(client, await readFile(paths.token, 'utf8'));
      client.close();
      versions.push((response.result as { hostVersion: string }).hostVersion);
    }

    expect(versions).toEqual([pkg.version, '9.8.7']);
  });

  it('второй startHost с тем же домом — HostAlreadyRunning, первый продолжает отвечать', async () => {
    const home = await tempTrackedHome();
    const running = await startHost({ home });
    hosts.push(running);

    const refused = await startHost({ home }).then(() => null, (error: unknown) => error);
    expect(refused).toBeInstanceOf(HostAlreadyRunning);
    expect((refused as Error).message).toBe('a host is already running for this Parley home');

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

  it('два одновременных старта в одном доме — работает ровно один, второй HostAlreadyRunning, файлы первого нетронуты (lane-r4, п. 2)', async () => {
    const home = await tempTrackedHome();
    const results = await Promise.allSettled([startHost({ home }), startHost({ home })]);
    const started = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    const refused = results.flatMap((r) => (r.status === 'rejected' ? [r.reason as unknown] : []));
    hosts.push(...started);
    expect(started).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toBeInstanceOf(HostAlreadyRunning);

    const paths = hostPaths(home);
    const token = await readFile(paths.token, 'utf8');
    const client = connectRaw(paths.socket);
    await waitConnected(client.socket);
    const response = await hello(client, token);
    expect(response.result).toMatchObject({ protocol: 1 });
    client.close();
    expect(lockPid(await readFile(paths.pid, 'utf8'))).toBe(process.pid);
  });

  it('замок живого pid без сокета (медленный старт первого) — HostAlreadyRunning, ничего не удалено (lane-r4, п. 2)', async () => {
    const home = await tempTrackedHome();
    const paths = hostPaths(home);
    // Первый хост взял замок и ещё не дошёл до listen: сокета нет, токен уже лежит.
    await mkdir(paths.dir, { recursive: true, mode: 0o700 });
    await writeFile(paths.pid, String(process.ppid));
    await writeFile(paths.token, 'first-token');

    await expect(startHost({ home })).rejects.toBeInstanceOf(HostAlreadyRunning);

    expect(await readFile(paths.pid, 'utf8')).toBe(String(process.ppid));
    expect(await readFile(paths.token, 'utf8')).toBe('first-token');
  });

  it('осколок замка мёртвого pid — старт проходит, в замке свой pid (lane-r4, п. 2)', async () => {
    const home = await tempTrackedHome();
    const paths = hostPaths(home);
    await mkdir(paths.dir, { recursive: true, mode: 0o700 });
    await writeFile(paths.pid, '999999');

    const running = await startHost({ home });
    hosts.push(running);
    expect(lockPid(await readFile(paths.pid, 'utf8'))).toBe(process.pid);
  });

  it('замок, записанный до перезагрузки системы, — осколок, даже если pid снова занят (lane-r4, п. 2)', async () => {
    const home = await tempTrackedHome();
    const paths = hostPaths(home);
    await mkdir(paths.dir, { recursive: true, mode: 0o700 });
    await writeFile(paths.pid, String(process.ppid));
    const beforeBoot = new Date(Date.now() - (uptime() + 3600) * 1000);
    await utimes(paths.pid, beforeBoot, beforeBoot);

    const running = await startHost({ home });
    hosts.push(running);
    expect(lockPid(await readFile(paths.pid, 'utf8'))).toBe(process.pid);
  });

  it('замок живого pid с другим временем старта — осколок (pid занял чужой процесс), старт проходит (lane-r5, п. 3)', async () => {
    const home = await tempTrackedHome();
    const paths = hostPaths(home);
    await mkdir(paths.dir, { recursive: true, mode: 0o700 });
    // Хост упал по SIGKILL, его pid до следующего старта достался другому процессу (здесь — живой
    // родитель тестов): pid жив, но время старта не то, что записал хост.
    await writeFile(paths.pid, `${process.ppid}\n2000-01-01T00:00:00.000Z\n`);

    const running = await startHost({ home });
    hosts.push(running);
    expect(lockPid(await readFile(paths.pid, 'utf8'))).toBe(process.pid);
  });

  it('замок живого pid со своим временем старта — HostAlreadyRunning, замок не тронут (lane-r5, п. 3)', async () => {
    const home = await tempTrackedHome();
    const paths = hostPaths(home);
    await mkdir(paths.dir, { recursive: true, mode: 0o700 });
    const started = await processStartedAt(process.ppid);
    const lock = `${process.ppid}\n${started ?? ''}\n`;
    await writeFile(paths.pid, lock);

    await expect(startHost({ home })).rejects.toBeInstanceOf(HostAlreadyRunning);
    expect(await readFile(paths.pid, 'utf8')).toBe(lock);
  });

  it('замок хранит pid и время старта процесса хоста (lane-r5, п. 3)', async () => {
    const home = await tempTrackedHome();
    const running = await startHost({ home });
    hosts.push(running);
    const [pid, startedAt] = (await readFile(hostPaths(home).pid, 'utf8')).split('\n');
    expect(pid).toBe(String(process.pid));
    expect(startedAt).toBe((await processStartedAt(process.pid)) ?? '');
  });

  it('остановка снимает замок; чужой замок не трогает (lane-r4, п. 2)', async () => {
    const home = await tempTrackedHome();
    const paths = hostPaths(home);
    const running = await startHost({ home });
    await running.context.shutdown('test');
    expect(existsSync(paths.pid)).toBe(false);

    const second = await startHost({ home });
    // Замок подменён (так не бывает у живого хоста, но остановка не должна удалять чужой pid).
    await writeFile(paths.pid, String(process.ppid));
    await second.context.shutdown('test');
    expect(await readFile(paths.pid, 'utf8')).toBe(String(process.ppid));
  });

  it('путь сокета длиннее 103 байт — SocketPathTooLong, каталог не создан', async () => {
    const longHome = `/tmp/hh-${'x'.repeat(150)}`;
    const refused = await startHost({ home: longHome }).then(() => null, (error: unknown) => error);
    expect(refused).toBeInstanceOf(SocketPathTooLong);
    expect((refused as Error).message).toMatch(/^socket path is longer than 103 bytes: /);
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
        env: { ...process.env, PARLEY_HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      try {
        await waitForFile(paths.pid, 10_000);

        const second = spawn(process.execPath, ['--import', tsxLoader, mainScript], {
          env: { ...process.env, PARLEY_HOME: home },
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

describe('битый works-index.json на старте (lane-r5, п. 1)', () => {
  it(
    'методы снимка отвечают ошибкой с причиной works-unreadable, а не висят; SIGTERM гасит процесс чисто',
    async () => {
      const home = await tempTrackedHome();
      const paths = hostPaths(home);
      await writeFile(path.join(home, 'works-index.json'), '{ битый');

      const child = spawn(process.execPath, ['--import', tsxLoader, mainScript], {
        env: { ...process.env, PARLEY_HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      try {
        await waitForFile(paths.socket, 10_000);
        const token = await readFile(paths.token, 'utf8');
        const client = connectRaw(paths.socket);
        await waitConnected(client.socket);
        await hello(client, token);
        client.send({ id: 1, method: 'works.list', params: {} });
        // Ответ ищется по id: до него могут прийти события. Висящий метод — отказ по сроку.
        const response = await Promise.race([
          (async () => {
            let message = await client.next();
            while (message.id !== 1) message = await client.next();
            return message;
          })(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('works.list не ответил')), 5000)),
        ]);
        expect(response.error).toMatchObject({ code: 'internal', data: { reason: 'works-unreadable' } });
        client.close();

        // Ответ с отказом уходит раньше, чем хост ставит обработчик SIGTERM (шаг 8): сигнал ждёт
        // строки «хост запущен» в журнале — старт дошёл до конца и после отказа первого чтения.
        await waitFor(async () => (await readFile(paths.log, 'utf8').catch(() => '')).includes('"msg":"хост запущен"'), 10_000);
        child.kill('SIGTERM');
        const [code] = (await once(child, 'exit')) as [number | null];
        expect(code).toBe(0);
        expect(existsSync(paths.socket)).toBe(false);
        expect(existsSync(paths.pid)).toBe(false);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    },
    20_000,
  );
});

describe('два процесса main.ts разом (lane-r4, п. 2)', () => {
  it(
    'одновременный запуск — один выходит с кодом 3, другой отвечает на hello',
    async () => {
      const home = await tempTrackedHome();
      const paths = hostPaths(home);
      const start = () =>
        spawn(process.execPath, ['--import', tsxLoader, mainScript], {
          env: { ...process.env, PARLEY_HOME: home },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      const children = [start(), start()];
      try {
        const loser = await Promise.race(
          children.map(async (child) => {
            const [code] = (await once(child, 'exit')) as [number | null];
            return { child, code };
          }),
        );
        expect(loser.code).toBe(3);
        const survivor = children.find((child) => child !== loser.child);
        expect(survivor?.exitCode).toBeNull();

        await waitForFile(paths.socket, 10_000);
        const token = await readFile(paths.token, 'utf8');
        const client = connectRaw(paths.socket);
        await waitConnected(client.socket);
        const response = await hello(client, token);
        expect(response.result).toMatchObject({ protocol: 1 });
        client.close();
        expect(lockPid(await readFile(paths.pid, 'utf8'))).toBe(survivor?.pid);
      } finally {
        for (const child of children) {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }
      }
    },
    20_000,
  );
});

/** pid держателя замка — первая строка `host.pid` (вторая — время старта процесса, lane-r5). */
function lockPid(text: string): number {
  return Number(text.split('\n')[0]);
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error('условие не наступило вовремя');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForFile(file: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!existsSync(file)) {
    if (Date.now() - start > timeoutMs) throw new Error(`файл не появился вовремя: ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
