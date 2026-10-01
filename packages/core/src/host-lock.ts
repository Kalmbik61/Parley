/**
 * Замок единственности хоста — файл `host.pid` в `<дом>/host/` — и проверка, жив ли хост дома.
 *
 * Замок пишет и снимает сам хост (`startHost`, раунды lane-r4 и lane-r5): первая строка — pid держателя,
 * вторая — время старта его процесса по ОС (пусто, если ОС его не сообщила). О том же перед переносом дома
 * спрашивает окно (`migrateHome`, R6): хост старого дома жив — дом не трогается. Правило «осколок это или
 * живой замок» одно на обоих, поэтому функции лежат в core, а не в хосте.
 */

import { readFile, stat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { uptime } from 'node:os';
import { isAlive, processStartedAt, START_TOLERANCE_MS } from './work/liveness.js';

/** Замок как он лежит на диске: текст и время записи файла. */
export interface HostLock {
  text: string;
  mtimeMs: number;
}

/** Читает замок; `null` — файла нет (хоста не было или замок только что сняли). */
export async function readHostLock(lockPath: string): Promise<HostLock | null> {
  try {
    const [text, info] = await Promise.all([readFile(lockPath, 'utf8'), stat(lockPath)]);
    return { text, mtimeMs: info.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** pid и записанное время старта из текста замка; прежний формат (только pid) — время `null`. */
export function parseHostLock(text: string): { pid: number; startedAt: string | null } {
  const [pidLine = '', startedLine = ''] = text.split('\n');
  const startedAt = startedLine.trim();
  return { pid: Number(pidLine.trim()), startedAt: startedAt === '' ? null : startedAt };
}

/**
 * Осколок: pid не число или мёртв; замок записан до загрузки системы; или pid жив, но время старта
 * его процесса не совпадает с записанным (раунд lane-r5) — хост упал, а pid до следующего старта
 * достался чужому процессу. Сверка — как у аренды работы (`hostLeaseActive`): допуск
 * START_TOLERANCE_MS; время неизвестно (замок прежнего формата или ОС не ответила) — прежнее правило,
 * живой pid держит замок: без второго признака чужой процесс не отличить, а снять живой замок хуже.
 */
export async function isStaleHostLock(lock: HostLock): Promise<boolean> {
  const { pid, startedAt } = parseHostLock(lock.text);
  if (!Number.isInteger(pid) || pid <= 0) return true;
  // Записан до загрузки системы: держатель мёртв, даже если его pid достался другому процессу.
  if (lock.mtimeMs < Date.now() - uptime() * 1000) return true;
  if (!isAlive(pid)) return true;
  if (startedAt === null) return false;
  const actual = await processStartedAt(pid);
  if (actual === null) return false;
  const diff = Math.abs(Date.parse(actual) - Date.parse(startedAt));
  return !Number.isNaN(diff) && diff > START_TOLERANCE_MS;
}

/** Пробует подключиться к существующему файлу сокета: жив ли за ним хост. */
export async function socketIsAlive(socketPath: string): Promise<boolean> {
  try {
    await stat(socketPath);
  } catch {
    return false;
  }
  return new Promise<boolean>((resolve) => {
    const socket = createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 500);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/**
 * Жив ли хост по файлам его каталога: замок не осколок (`isStaleHostLock`) или за сокетом кто-то слушает
 * (хост без замка — до раунда lane-r4 замка не было). Замок, который не прочитался (нет прав), — ошибка, а
 * не «хоста нет»: так решать нельзя, вызывающий отказывается от действия.
 */
export async function hostAlive(files: { pid: string; socket: string }): Promise<boolean> {
  const lock = await readHostLock(files.pid);
  if (lock !== null && !(await isStaleHostLock(lock))) return true;
  return socketIsAlive(files.socket);
}
