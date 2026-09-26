import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Хост переживает выход окна — так задумано, но в E2E это утечка: каждый тест
 * оставлял живой хост во временном доме, а заглушки агентов держали его
 * сессии живыми, и он не уходил даже по простою. Сотни таких процессов
 * грузили машину. После теста хост гасится по своему pid (SIGTERM: он сам
 * останавливает свои PTY), и только потом дом удаляется.
 */
export async function stopHost(home: string): Promise<void> {
  let pid: number;
  try {
    pid = Number((await readFile(path.join(home, 'host', 'host.pid'), 'utf8')).trim());
  } catch {
    return;
  }
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // уже вышел
  }
}
