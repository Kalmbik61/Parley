/**
 * Аренда работы хостом: файл `<project>/.harnas/works/<id>/host.lease` —
 * отметка, что эту работу уже открыл хост (спецификация, разделы 3.3, 4.2, 10).
 * TUI сверяется с ней перед автозапуском `pending`-сессий, чтобы не поднимать
 * то, чем уже занят хост.
 *
 * Живость аренды проверяется тем же способом, что и живость сессии агента
 * (`work/liveness.ts`): пара pid + время старта процесса — один голый pid ОС
 * переиспользует, а второй признак отличает старого арендатора от нового.
 */

import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isAlive, processStartedAt, START_TOLERANCE_MS } from './liveness.js';
import { workPaths } from './store.js';

export interface HostLease {
  pid: number;
  startedAtProcess: string | null;
  since: string;
}

const leaseFile = (projectPath: string, workId: string): string =>
  path.join(workPaths(projectPath, workId).dir, 'host.lease');

/** Пишет аренду, перетирая чужую: работу держит последний хост, который её открыл. */
export async function writeHostLease(
  projectPath: string,
  workId: string,
  lease: HostLease,
): Promise<void> {
  await writeFile(leaseFile(projectPath, workId), `${JSON.stringify(lease, null, 2)}\n`, 'utf8');
}

/** Читает аренду. Файла нет или он не разбирается — арендатора не знаем, догадок не строим. */
export async function readHostLease(
  projectPath: string,
  workId: string,
): Promise<HostLease | null> {
  let raw: string;
  try {
    raw = await readFile(leaseFile(projectPath, workId), 'utf8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw) as HostLease;
  } catch {
    return null;
  }
}

/**
 * Жива ли аренда — критерий тот же, что у живости сессии (`checkSession`): pid
 * жив, и время его старта совпадает с записанным в пределах допуска.
 */
export async function hostLeaseActive(projectPath: string, workId: string): Promise<boolean> {
  const lease = await readHostLease(projectPath, workId);
  if (lease === null) return false;
  if (!isAlive(lease.pid)) return false;

  const actual = await processStartedAt(lease.pid);
  if (actual === null || lease.startedAtProcess === null) return true;
  const diff = Math.abs(Date.parse(actual) - Date.parse(lease.startedAtProcess));
  return Number.isNaN(diff) || diff <= START_TOLERANCE_MS;
}

/**
 * Снимает аренду, только если она своя: чужой хост мог её уже переписать
 * (например, после перезапуска) — снимать чужую аренду нельзя, работа осталась
 * бы без хозяина, хотя её на самом деле держит кто-то другой.
 */
export async function removeHostLease(
  projectPath: string,
  workId: string,
  pid: number,
): Promise<void> {
  const lease = await readHostLease(projectPath, workId);
  if (lease === null || lease.pid !== pid) return;
  await rm(leaseFile(projectPath, workId), { force: true });
}
