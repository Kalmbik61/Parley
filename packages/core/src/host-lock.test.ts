import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  hostAlive,
  isStaleHostLock,
  parseHostLock,
  readHostLock,
  socketIsAlive,
} from './host-lock.js';
import { processStartedAt } from './work/liveness.js';

/** Каталог хоста — прямо в `/tmp`: путь unix-сокета на macOS ограничен 103 байтами, а `os.tmpdir()` длинный. */
let dir = '';
const servers: Server[] = [];
const children: ChildProcess[] = [];

beforeEach(async () => {
  dir = await mkdtemp('/tmp/hl-');
});

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  }
  await rm(dir, { recursive: true, force: true });
});

const files = (): { pid: string; socket: string } => ({
  pid: path.join(dir, 'host.pid'),
  socket: path.join(dir, 'host.sock'),
});

/** Настоящий сокет, за которым кто-то слушает. */
async function listen(socketPath: string): Promise<void> {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
}

/** Настоящий чужой процесс: его pid живой, а время старта можно спросить у ОС. */
function startChild(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  children.push(child);
  return child;
}

/** Замок такого вида, каким его пишет хост: pid и время старта процесса. */
const lockText = (pid: number, startedAt: string | null): string => `${pid}\n${startedAt ?? ''}\n`;

const fresh = { mtimeMs: Date.now() };

describe('parseHostLock', () => {
  it('две строки — pid и время старта; прежний формат (одна строка) — время null; мусор — NaN', () => {
    expect(parseHostLock('123\n2026-09-30T10:00:00.000Z\n')).toEqual({ pid: 123, startedAt: '2026-09-30T10:00:00.000Z' });
    expect(parseHostLock('123\n')).toEqual({ pid: 123, startedAt: null });
    expect(parseHostLock('123\n\n')).toEqual({ pid: 123, startedAt: null });
    expect(parseHostLock('не pid').pid).toBeNaN();
  });
});

describe('readHostLock', () => {
  it('читает текст и время записи; файла нет — null', async () => {
    const { pid } = files();
    expect(await readHostLock(pid)).toBeNull();

    await writeFile(pid, '123\n');
    const lock = await readHostLock(pid);
    expect(lock?.text).toBe('123\n');
    expect(lock?.mtimeMs).toBeGreaterThan(0);
  });

  it('файл не читается не по причине «нет файла» — ошибка, а не «замка нет»', async () => {
    // Вместо файла — каталог: чтение даёт EISDIR.
    await mkdir(files().pid);
    await expect(readHostLock(files().pid)).rejects.toThrow();
  });
});

describe('isStaleHostLock', () => {
  it('pid не число или не положительный — осколок', async () => {
    expect(await isStaleHostLock({ text: 'мусор\n', ...fresh })).toBe(true);
    expect(await isStaleHostLock({ text: '0\n', ...fresh })).toBe(true);
    expect(await isStaleHostLock({ text: '', ...fresh })).toBe(true);
  });

  it('мёртвый pid — осколок', async () => {
    expect(await isStaleHostLock({ text: lockText(999_999, null), ...fresh })).toBe(true);
  });

  it('живой pid: время старта не записано — замок держит; совпало — держит; разошлось — осколок (pid достался чужому)', async () => {
    const child = startChild();
    const pid = child.pid ?? 0;
    const startedAt = await processStartedAt(pid);

    expect(await isStaleHostLock({ text: lockText(pid, null), ...fresh })).toBe(false);
    expect(await isStaleHostLock({ text: lockText(pid, startedAt), ...fresh })).toBe(false);
    expect(await isStaleHostLock({ text: lockText(pid, '2020-01-01T00:00:00.000Z'), ...fresh })).toBe(true);
  });

  it('замок записан до загрузки системы — осколок, даже если pid жив', async () => {
    expect(await isStaleHostLock({ text: lockText(process.pid, null), mtimeMs: 1 })).toBe(true);
  });
});

describe('socketIsAlive', () => {
  it('слушающий сокет — жив; файла нет — нет; файл сокета без слушателя — нет', async () => {
    const { socket } = files();
    expect(await socketIsAlive(socket)).toBe(false);

    await listen(socket);
    expect(await socketIsAlive(socket)).toBe(true);

    // Обычный файл на месте сокета: подключиться не к чему.
    const dead = path.join(dir, 'dead.sock');
    await writeFile(dead, '');
    expect(await socketIsAlive(dead)).toBe(false);
  });
});

describe('hostAlive — жив ли хост по файлам его каталога', () => {
  it('нет ни замка, ни сокета — хоста нет', async () => {
    expect(await hostAlive(files())).toBe(false);
  });

  it('замок живого держателя — хост жив, и без сокета (медленный старт)', async () => {
    const startedAt = await processStartedAt(process.pid);
    await writeFile(files().pid, lockText(process.pid, startedAt));
    expect(await hostAlive(files())).toBe(true);
  });

  it('осколок замка без сокета — хоста нет', async () => {
    await writeFile(files().pid, lockText(999_999, null));
    expect(await hostAlive(files())).toBe(false);
  });

  it('осколок замка, но за сокетом кто-то слушает — хост жив', async () => {
    await writeFile(files().pid, lockText(999_999, null));
    await listen(files().socket);
    expect(await hostAlive(files())).toBe(true);
  });

  it('хост без замка (сборка до замка), но с живым сокетом — хост жив', async () => {
    await listen(files().socket);
    expect(await hostAlive(files())).toBe(true);
  });

  it('замок, давний как сама загрузка системы, — осколок', async () => {
    await writeFile(files().pid, lockText(process.pid, null));
    await utimes(files().pid, new Date(1000), new Date(1000));
    expect(await hostAlive(files())).toBe(false);
  });
});
