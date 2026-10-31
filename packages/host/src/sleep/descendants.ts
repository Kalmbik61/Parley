/**
 * Потомки процесса агента после его сна (спека сна агентов, 4.6). Перед остановкой по сну хост запоминает потомков CLI
 * (MCP-серверы, фоновые команды), а через `SURVIVOR_CHECK_MS` после выхода пишет в журнал тех, кто остался жив.
 *
 * Хост ничего не убивает: общие сервисы и чужие процессы трогать нельзя. Записи — данные для следующего этапа.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAlive } from '@parley/core';

const run = promisify(execFile);

/** Через сколько после выхода процесса агента проверяют, кто из его потомков остался жив. */
export const SURVIVOR_CHECK_MS = 10_000;

/** Сон ждёт `ps` до остановки процесса: зависший вызов его держать не должен. */
const PS_TIMEOUT_MS = 5_000;

/** Строка снимка `ps -axo pid=,ppid=`: два числа, колонки выровнены пробелами. */
const ROW = /^\s*(\d+)\s+(\d+)\s*$/;

/** Один снимок таблицы процессов: по строке `<pid> <ppid>`, без заголовка. */
async function psSnapshot(): Promise<string> {
  const { stdout } = await run('ps', ['-axo', 'pid=,ppid='], { timeout: PS_TIMEOUT_MS });
  return stdout;
}

/**
 * Потомки `rootPid` транзитивно по одному снимку `ps`, по возрастанию pid; сам корень в них не входит. Сбой `ps` даёт
 * пустой список: сну это не мешает, а выжившие просто не будут записаны.
 */
export async function descendantPids(rootPid: number, ps: () => Promise<string> = psSnapshot): Promise<number[]> {
  let output: string;
  try {
    output = await ps();
  } catch {
    return [];
  }
  const childrenOf = new Map<number, number[]>();
  for (const line of output.split('\n')) {
    const match = ROW.exec(line);
    if (match === null) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const siblings = childrenOf.get(ppid);
    if (siblings === undefined) childrenOf.set(ppid, [pid]);
    else siblings.push(pid);
  }
  const found = new Set<number>();
  const queue = [rootPid];
  for (let pid = queue.shift(); pid !== undefined; pid = queue.shift()) {
    for (const child of childrenOf.get(pid) ?? []) {
      if (child === rootPid || found.has(child)) continue;
      found.add(child);
      queue.push(child);
    }
  }
  return [...found].sort((a, b) => a - b);
}

/** Те из `pids`, что ещё живы (`process.kill(pid, 0)`, как `isAlive` в core). */
export function alivePids(pids: readonly number[], alive: (pid: number) => boolean = isAlive): number[] {
  return pids.filter((pid) => alive(pid));
}
