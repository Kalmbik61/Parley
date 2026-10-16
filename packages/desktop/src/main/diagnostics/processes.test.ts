import type { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { PS_ARGS, processTree, systemSummary } from './processes.js';

const HEADER = '  PID  PPID  %CPU %MEM    RSS     ELAPSED COMM';

/** Готовый вывод ps: хост 100, дети 101 и 102 (ppid 101), чужой 200, у 103 comm с пробелами. */
const PS_OUTPUT = [
  HEADER,
  '  100     1   0.5  0.1  20480    01:02:03 /usr/local/bin/node',
  '  101   100   1.0  0.2  10240       00:59 /bin/claude',
  '  102   101   0.0  0.0   2048       00:58 /usr/bin/mcp-server',
  '  103   102   0.0  0.0   1024       00:57 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '  200     1   0.1  0.0   4096    02:00:00 /usr/sbin/cfprefsd',
  '',
].join('\n');

interface FakeChild extends EventEmitter {
  stdout: Readable;
  kill: ReturnType<typeof vi.fn>;
}

/** Fake `spawn`: после подписки отдаёт вывод и закрывается с кодом; `closes: false` — не закрывается никогда. */
function fakeSpawn(options: { output?: string; code?: number; closes?: boolean }) {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new Readable({ read() {} });
  child.kill = vi.fn();
  const spawnFn = vi.fn(() => {
    if (options.closes !== false) {
      setImmediate(() => {
        child.stdout.push(options.output ?? '');
        child.stdout.push(null);
        child.stdout.once('end', () => child.emit('close', options.code ?? 0));
      });
    }
    return child;
  });
  return { child, spawnFn: spawnFn as unknown as typeof spawn, mock: spawnFn };
}

describe('processTree', () => {
  it('оставляет заголовок и строки замыкания rootPids по ppid, comm с пробелами не теряется', async () => {
    const { spawnFn, mock } = fakeSpawn({ output: PS_OUTPUT });

    const result = await processTree([100], { spawn: spawnFn });

    expect(mock).toHaveBeenCalledWith('ps', PS_ARGS, expect.anything());
    const lines = result.split('\n');
    expect(lines[0]).toBe(HEADER);
    const pids = lines.slice(1).map((line) => Number(line.trim().split(/\s+/)[0]));
    expect(pids).toEqual([100, 101, 102, 103]);
    expect(result).toContain('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    expect(result).not.toContain('cfprefsd');
  });

  it('несколько корней: берутся поддеревья каждого', async () => {
    const { spawnFn } = fakeSpawn({ output: PS_OUTPUT });

    const result = await processTree([102, 200], { spawn: spawnFn });

    const pids = result
      .split('\n')
      .slice(1)
      .map((line) => Number(line.trim().split(/\s+/)[0]));
    expect(pids).toEqual([102, 103, 200]);
  });

  it('таймаут: процесс убит, вместо вывода строка о таймауте', async () => {
    const { spawnFn, child } = fakeSpawn({ closes: false });

    const result = await processTree([100], { spawn: spawnFn, timeoutMs: 20 });

    expect(result).toBe('ps: timed out after 20 ms');
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('таймаут по умолчанию 5000 мс (fake timers)', async () => {
    vi.useFakeTimers();
    try {
      const { spawnFn, child } = fakeSpawn({ closes: false });

      const pending = processTree([100], { spawn: spawnFn });
      await vi.advanceTimersByTimeAsync(5000);

      expect(await pending).toBe('ps: timed out after 5000 ms');
      expect(child.kill).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ошибка запуска (событие error) → ps: <message>', async () => {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new Readable({ read() {} });
    child.kill = vi.fn();
    const spawnFn = (() => {
      setImmediate(() => child.emit('error', new Error('spawn ps ENOENT')));
      return child;
    }) as unknown as typeof spawn;

    expect(await processTree([100], { spawn: spawnFn })).toBe('ps: spawn ps ENOENT');
  });

  it('spawn бросает синхронно → ps: <message>', async () => {
    const spawnFn = (() => {
      throw new Error('EACCES');
    }) as unknown as typeof spawn;

    expect(await processTree([100], { spawn: spawnFn })).toBe('ps: EACCES');
  });

  it('ненулевой код выхода → ps: <message>', async () => {
    const { spawnFn } = fakeSpawn({ output: '', code: 2 });

    expect(await processTree([100], { spawn: spawnFn })).toBe('ps: exited with code 2');
  });

  it('настоящий ps с [process.pid] содержит строку с process.pid', async () => {
    const result = await processTree([process.pid]);

    const pids = result
      .split('\n')
      .slice(1)
      .map((line) => Number(line.trim().split(/\s+/)[0]));
    expect(pids).toContain(process.pid);
  });
});

describe('systemSummary', () => {
  it('по строке на значение: load average, cpus, mem total/free в МиБ, uptime в секундах', () => {
    const summary = systemSummary({
      os: {
        loadavg: () => [1.5, 2.25, 3],
        cpus: () => new Array(8).fill({}) as ReturnType<typeof import('node:os').cpus>,
        totalmem: () => 16 * 1024 * 1024 * 1024,
        freemem: () => 2048 * 1024 * 1024 + 1000,
        uptime: () => 12345.6,
      },
    });

    expect(summary.split('\n')).toEqual([
      'load average (1/5/15): 1.50 2.25 3.00',
      'cpus: 8',
      'mem total: 16384 MiB',
      'mem free: 2048 MiB',
      'uptime: 12346 s',
    ]);
  });
});
