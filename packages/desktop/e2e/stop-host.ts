import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const dirname = path.dirname(fileURLToPath(import.meta.url));
/** Точка входа хоста этого дерева: окно запускает её по настоящему пути (`require.resolve`). */
const hostEntry = path.resolve(dirname, '../../host/dist/main.js');

/**
 * Хост переживает выход окна — так задумано, но в E2E это утечка: каждый тест
 * оставлял живой хост во временном доме, а заглушки агентов держали его
 * сессии живыми, и он не уходил даже по простою. Сотни таких процессов
 * грузили машину. После теста хост гасится по своему pid (SIGTERM: он сам
 * останавливает свои PTY), и только потом дом удаляется.
 *
 * pid-файл хост пишет не сразу, а после сокета: под нагрузкой тест падал раньше, и хост,
 * поднятый окном, оставался жить без pid-файла. Поэтому хост ищется ещё и по `host.err` —
 * его stderr, который окно открывает до запуска процесса (`spawnHost`): держит этот файл
 * только хост этого дома с первого мгновения. Гасится лишь процесс с командой хоста этого
 * дерева — занявший освободившийся pid чужой процесс не тронется.
 */
export async function stopHost(home: string): Promise<void> {
  const dir = path.join(home, 'host');
  const pids = new Set(await pidsHolding(path.join(dir, 'host.err')));
  // Первая строка замка — pid, вторая — время старта процесса (раунд lane-r5).
  const fromFile = Number((await readFile(path.join(dir, 'host.pid'), 'utf8').catch(() => '')).split('\n')[0]);
  if (Number.isInteger(fromFile) && fromFile > 0) pids.add(fromFile);
  await Promise.all(
    [...pids].map(async (pid) => {
      if (await isHost(pid)) await terminate(pid);
    }),
  );
}

/** pid процессов, держащих файл открытым; файла нет или никто не держит — пусто. */
async function pidsHolding(file: string): Promise<number[]> {
  if (!existsSync(file)) return [];
  try {
    const { stdout } = await run('lsof', ['-t', '--', file]);
    return stdout
      .split('\n')
      .map(Number)
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    // Код 1 у lsof — файл никто не держит.
    return [];
  }
}

async function isHost(pid: number): Promise<boolean> {
  try {
    const { stdout } = await run('ps', ['-o', 'command=', '-p', String(pid)]);
    return stdout.trim().endsWith(` ${hostEntry}`);
  } catch {
    return false;
  }
}

async function terminate(pid: number): Promise<void> {
  if (!signal(pid, 'SIGTERM') || (await gone(pid))) return;
  // Под нагрузкой хост не успевал выйти сам; после SIGKILL тоже ждём, пока процесс исчезнет, —
  // иначе уборка заканчивалась при ещё живом хосте.
  if (signal(pid, 'SIGKILL')) await gone(pid);
}

function signal(pid: number, name: NodeJS.Signals): boolean {
  try {
    process.kill(pid, name);
    return true;
  } catch {
    // уже вышел
    return false;
  }
}

async function gone(pid: number): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}
