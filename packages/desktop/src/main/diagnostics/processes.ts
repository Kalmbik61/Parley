import { spawn } from 'node:child_process';
import os from 'node:os';

/**
 * Аргументы `ps` для архива диагностики. Только `comm` (исполняемый файл), без аргументов
 * командной строки: в argv claude/codex лежат бриф сессии, а у их потомков (MCP-серверы)
 * бывают токены (спека A2, A7).
 */
export const PS_ARGS = ['-axo', 'pid,ppid,%cpu,%mem,rss,etime,comm'];

const PS_TIMEOUT_MS = 5000;

/** Шесть колонок до `comm` (pid, ppid, %cpu, %mem, rss, etime); `comm` — остаток строки, в нём бывают пробелы. */
const PS_ROW = /^\s*(\d+)\s+(\d+)\s+\S+\s+\S+\s+\S+\s+\S+\s+.+$/;

/** Запускает `ps` и возвращает вывод одной строкой; сбои и таймаут превращает в строку `ps: …`. */
function runPs(spawnFn: typeof spawn, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const settle = (text: string): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(text);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawnFn('ps', PS_ARGS, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (err) {
      settle(`ps: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    timer = setTimeout(() => {
      child.kill();
      settle(`ps: timed out after ${timeoutMs} ms`);
    }, timeoutMs);

    let output = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      output += chunk;
    });
    child.on('error', (err) => settle(`ps: ${err.message}`));
    child.on('close', (code) => {
      settle(code === 0 ? output : `ps: exited with code ${code}`);
    });
  });
}

/**
 * Строка заголовка `ps` и строки процессов из замыкания `rootPids` по `ppid` (корни и все
 * потомки транзитивно) — как их выдал `ps`. При таймауте или сбое вместо дерева — строка `ps: …`.
 */
export async function processTree(
  rootPids: readonly number[],
  deps: { spawn?: typeof spawn; timeoutMs?: number } = {},
): Promise<string> {
  const output = await runPs(deps.spawn ?? spawn, deps.timeoutMs ?? PS_TIMEOUT_MS);
  if (output.startsWith('ps: ')) return output;

  const [header = '', ...rows] = output.split('\n');
  const parsed: { pid: number; ppid: number; line: string }[] = [];
  const childrenOf = new Map<number, number[]>();
  for (const line of rows) {
    const match = PS_ROW.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    parsed.push({ pid, ppid, line });
    const siblings = childrenOf.get(ppid);
    if (siblings) siblings.push(pid);
    else childrenOf.set(ppid, [pid]);
  }

  const inTree = new Set<number>(rootPids);
  const queue = [...rootPids];
  for (let pid = queue.shift(); pid !== undefined; pid = queue.shift()) {
    for (const child of childrenOf.get(pid) ?? []) {
      if (inTree.has(child)) continue;
      inTree.add(child);
      queue.push(child);
    }
  }

  return [header, ...parsed.filter((row) => inTree.has(row.pid)).map((row) => row.line)].join('\n');
}

/** Сводка системы для `processes.txt`: по строке на значение. */
export function systemSummary(
  deps: { os?: Pick<typeof os, 'loadavg' | 'cpus' | 'totalmem' | 'freemem' | 'uptime'> } = {},
): string {
  const system = deps.os ?? os;
  const mib = (bytes: number): number => Math.round(bytes / (1024 * 1024));
  return [
    `load average (1/5/15): ${system
      .loadavg()
      .map((value) => value.toFixed(2))
      .join(' ')}`,
    `cpus: ${system.cpus().length}`,
    `mem total: ${mib(system.totalmem())} MiB`,
    `mem free: ${mib(system.freemem())} MiB`,
    `uptime: ${Math.round(system.uptime())} s`,
  ].join('\n');
}
