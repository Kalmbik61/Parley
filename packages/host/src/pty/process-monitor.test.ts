import type { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { SessionRef } from '@parley/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Log } from '../log.js';
import type { PtyHandle } from './pty-manager.js';
import { createProcessMonitor, POLL_INTERVAL_MS, PS_ARGS } from './process-monitor.js';
import type { ProcessSnapshot } from './process-monitor.js';

const HEADER = '  PID  PPID  %CPU %MEM    RSS     ELAPSED UCOMM';

const ref = (sessionId: string): SessionRef => ({ projectPath: '/p', workId: 'w', sessionId });

/** Ручка PTY: монитору нужны только `ref`, `pid` и `provider`. */
const handle = (sessionId: string, pid: number, provider: string | null = 'claude'): PtyHandle =>
  ({ ref: ref(sessionId), pid, provider }) as PtyHandle;

/** Строки `ps` из троек [pid, ppid, ucomm]; `ucomm` дополняется пробелами до 16, как делает macOS. */
const psOutput = (rows: Array<[number, number, string]>): string =>
  [HEADER, ...rows.map(([pid, ppid, name]) => `${pid} ${ppid} 0.4 0.1 20480 00:30 ${name.padEnd(16)}`), ''].join('\n');

interface FakeChild extends EventEmitter {
  stdout: Readable;
  kill: ReturnType<typeof vi.fn>;
}

/**
 * Fake `spawn`: отдаёт готовый вывод `ps`. `delayMs` — сколько ps «работает» (по fake-таймерам),
 * без него отвечает в микрозадаче; `closes: false` — висит до таймаута. Каждый вызов — свой child.
 */
function fakeSpawn(options: { output?: string; code?: number; closes?: boolean; delayMs?: number; throws?: boolean } = {}) {
  const spawnFn = vi.fn<(command: string, args: string[], options: { env?: Record<string, string> }) => FakeChild>(() => {
    if (options.throws === true) throw new Error('spawn ps ENOENT');
    const child = new EventEmitter() as FakeChild;
    child.stdout = new Readable({ read() {} });
    child.kill = vi.fn();
    const finish = (): void => {
      child.stdout.push(options.output ?? '');
      child.stdout.push(null);
      child.stdout.once('end', () => child.emit('close', options.code ?? 0));
    };
    if (options.closes !== false) {
      if (options.delayMs === undefined) queueMicrotask(finish);
      else setTimeout(finish, options.delayMs);
    }
    return child;
  });
  return { spawnFn: spawnFn as unknown as typeof spawn, mock: spawnFn };
}

const silentLog = (): Log => ({ info: () => {}, warn: () => {} });

const collect = () => {
  const seen: Array<{ sessionId: string; names: string[]; snapshot: ProcessSnapshot | null }> = [];
  return {
    seen,
    listener: (r: SessionRef, snapshot: ProcessSnapshot | null) =>
      seen.push({ sessionId: r.sessionId, names: snapshot?.processes.map((p) => p.name).sort() ?? [], snapshot }),
  };
};

/** Монитор с одним PTY; возвращает снимок первого опроса. */
async function snapshotOf(rows: Array<[number, number, string]>, provider: string | null, root = 1) {
  const { spawnFn } = fakeSpawn({ output: psOutput(rows) });
  const monitor = createProcessMonitor({ log: silentLog(), livePtys: () => [handle('s-1', root, provider)], spawn: spawnFn });
  const seen = collect();
  const off = monitor.subscribe(ref('s-1'), seen.listener);
  await monitor.refresh();
  off();
  monitor.stop();
  return seen.seen[0];
}

afterEach(() => {
  vi.useRealTimers();
});

describe('колонки и локаль', () => {
  it('запрашивает ucomm, а не comm и не args', () => {
    expect(PS_ARGS).toEqual(['-axo', 'pid,ppid,%cpu,%mem,rss,etime,ucomm']);
  });

  it('ps запускается с LC_ALL=C: запятая вместо точки в локали ru_RU ломала бы %cpu', async () => {
    const { spawnFn, mock } = fakeSpawn({ output: psOutput([]) });
    const monitor = createProcessMonitor({ log: silentLog(), livePtys: () => [handle('s-1', 1)], spawn: spawnFn });
    monitor.subscribe(ref('s-1'), () => {});
    await monitor.refresh();
    const options = mock.mock.calls[0]?.[2];
    expect(options?.env?.LC_ALL).toBe('C');
    monitor.stop();
  });
});

describe('классификация по дереву (фикстуры живого замера 2026-11-09)', () => {
  it('Claude в простое: MCP, caffeinate и вложенные node — не команды, снимок пуст и доступен', async () => {
    const seen = await snapshotOf(
      [
        [1, 0, '2.1.319'],
        [2, 1, 'node'],
        [3, 1, 'caffeinate'],
        [4, 1, 'mcp-server-darwi'],
        [5, 1, 'node'],
        [6, 5, 'node'],
        [7, 6, 'node'],
      ],
      'claude',
    );
    expect(seen?.snapshot).toEqual({ processes: [], approximate: false });
  });

  it('Claude: zsh → docker, head даёт три строки', async () => {
    const seen = await snapshotOf(
      [
        [1, 0, '2.1.319'],
        [2, 1, 'zsh'],
        [3, 2, 'docker'],
        [4, 2, 'head'],
      ],
      'claude',
    );
    expect(seen?.names).toEqual(['docker', 'head', 'zsh']);
  });

  it('custom-claude-api классифицируется как Claude', async () => {
    const seen = await snapshotOf(
      [
        [1, 0, '2.1.319'],
        [2, 1, 'node'],
        [3, 1, 'zsh'],
        [4, 3, 'sleep'],
      ],
      'custom-claude-api',
    );
    expect(seen?.names).toEqual(['sleep', 'zsh']);
    expect(seen?.snapshot?.approximate).toBe(false);
  });

  it('Codex в простое: node → codex → node, node_repl, codex-code-mode- — пустой приблизительный снимок', async () => {
    const seen = await snapshotOf(
      [
        [1, 0, 'node'],
        [2, 1, 'codex'],
        [3, 2, 'node'],
        [4, 1, 'node'],
        [5, 4, 'node_repl'],
        [6, 2, 'codex-code-mode-'],
      ],
      'codex',
    );
    expect(seen?.snapshot).toEqual({ processes: [], approximate: true });
  });

  it('Codex: прямой sleep под codex виден', async () => {
    const seen = await snapshotOf(
      [
        [1, 0, 'node'],
        [2, 1, 'codex'],
        [3, 2, 'sleep'],
      ],
      'codex',
    );
    expect(seen?.names).toEqual(['sleep']);
  });

  it('Codex: zsh → sleep, cat даёт три строки', async () => {
    const seen = await snapshotOf(
      [
        [1, 0, 'node'],
        [2, 1, 'codex'],
        [3, 2, 'zsh'],
        [4, 3, 'sleep'],
        [5, 3, 'cat'],
      ],
      'codex',
    );
    expect(seen?.names).toEqual(['cat', 'sleep', 'zsh']);
  });

  it('Codex: прямой node скрыт, node → sh → vitest даёт sh и vitest', async () => {
    const seen = await snapshotOf(
      [
        [1, 0, 'node'],
        [2, 1, 'codex'],
        [3, 2, 'node'],
        [4, 3, 'sh'],
        [5, 4, 'vitest'],
        [6, 1, 'node'],
      ],
      'codex',
    );
    expect(seen?.names).toEqual(['sh', 'vitest']);
  });

  it('корень агента в список не попадает, чужие процессы тоже', async () => {
    const seen = await snapshotOf(
      [
        [1, 0, 'zsh'],
        [2, 1, 'zsh'],
        [900, 1000, 'zsh'],
      ],
      'claude',
    );
    expect(seen?.snapshot?.processes.map((p) => p.pid)).toEqual([2]);
  });

  it('метрики разобраны числами, имя без хвостовых пробелов ucomm', async () => {
    const seen = await snapshotOf(
      [
        [1, 0, '2.1.319'],
        [2, 1, 'mcp-server-darwi'],
        [3, 1, 'zsh'],
      ],
      'claude',
    );
    expect(seen?.snapshot?.processes).toEqual([{ pid: 3, name: 'zsh', elapsed: '00:30', cpuPct: 0.4, memPct: 0.1, rssKb: 20480 }]);
  });
});

describe('настоящий ps', () => {
  it.skipIf(process.platform === 'win32')('подменённый argv[0] с токеном не попадает в снимок, имя — sleep, cpuPct — число', async () => {
    const { spawn: realSpawn } = await import('node:child_process');
    const previous = process.env.LC_ALL;
    process.env.LC_ALL = 'ru_RU.UTF-8';   // монитор обязан сам вернуть C
    const child = realSpawn('bash', ['-c', '(exec -a "fake --token=SECRET-PROBE" sleep 30) & wait'], { stdio: 'ignore' });
    const monitor = createProcessMonitor({ log: silentLog(), livePtys: () => [handle('s-1', process.pid)] });
    const snapshots: Array<ProcessSnapshot | null> = [];
    monitor.subscribe(ref('s-1'), (_ref, snapshot) => snapshots.push(snapshot));
    try {
      let found: ProcessSnapshot | undefined;
      for (let attempt = 0; attempt < 30 && found === undefined; attempt += 1) {
        await monitor.refresh();
        found = snapshots.at(-1)?.processes.some((p) => p.name === 'sleep') === true ? (snapshots.at(-1) ?? undefined) : undefined;
        if (found === undefined) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(found, 'sleep не появился в снимке').toBeDefined();
      const sleep = found?.processes.find((p) => p.name === 'sleep');
      expect(typeof sleep?.cpuPct).toBe('number');
      expect(JSON.stringify(snapshots)).not.toContain('SECRET-PROBE');
      expect(JSON.stringify(snapshots)).not.toContain('fake');
      for (const p of found?.processes ?? []) {
        try { process.kill(p.pid, 'SIGKILL'); } catch { /* уже завершился */ }
      }
    } finally {
      monitor.stop();
      child.kill('SIGKILL');
      if (previous === undefined) delete process.env.LC_ALL;
      else process.env.LC_ALL = previous;
    }
  });
});

describe('жизненный цикл и таймер', () => {
  it('один ps на тик обслуживает все живые PTY', async () => {
    const { spawnFn, mock } = fakeSpawn({ output: psOutput([[2, 1, 'zsh'], [3, 1, 'zsh']]) });
    const monitor = createProcessMonitor({
      log: silentLog(),
      livePtys: () => [handle('s-1', 1), handle('s-2', 1)],
      spawn: spawnFn,
    });
    const first = collect();
    const second = collect();
    monitor.subscribe(ref('s-1'), first.listener);
    monitor.subscribe(ref('s-2'), second.listener);
    await monitor.refresh();
    expect(mock).toHaveBeenCalledTimes(1);
    expect(first.seen).toHaveLength(1);
    expect(second.seen).toHaveLength(1);
    monitor.stop();
  });

  it('несколько сессий: у каждой свой снимок по своему PID', async () => {
    const { spawnFn } = fakeSpawn({ output: psOutput([[2, 1, 'zsh'], [3, 2, 'sleep'], [12, 11, 'bash']]) });
    const monitor = createProcessMonitor({
      log: silentLog(),
      livePtys: () => [handle('s-1', 1), handle('s-2', 11)],
      spawn: spawnFn,
    });
    const first = collect();
    const second = collect();
    monitor.subscribe(ref('s-1'), first.listener);
    monitor.subscribe(ref('s-2'), second.listener);
    await monitor.refresh();
    expect(first.seen[0]?.names).toEqual(['sleep', 'zsh']);
    expect(second.seen[0]?.names).toEqual(['bash']);
    monitor.stop();
  });

  it('опрос идёт по таймеру, один ps на тик; последний ушёл — таймер снят', async () => {
    vi.useFakeTimers();
    const { spawnFn, mock } = fakeSpawn({ output: psOutput([]) });
    const monitor = createProcessMonitor({ log: silentLog(), livePtys: () => [handle('s-1', 1)], spawn: spawnFn });
    const off = monitor.subscribe(ref('s-1'), () => {});
    expect(mock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    expect(mock).toHaveBeenCalledTimes(3);
    off();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5);
    expect(mock).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('повторная отписка безвредна, таймер остаётся у живого подписчика', async () => {
    vi.useFakeTimers();
    const { spawnFn, mock } = fakeSpawn({ output: psOutput([]) });
    const monitor = createProcessMonitor({ log: silentLog(), livePtys: () => [handle('s-1', 1)], spawn: spawnFn });
    const offA = monitor.subscribe(ref('s-1'), () => {});
    monitor.subscribe(ref('s-1'), () => {});
    offA();
    offA();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
    expect(mock).toHaveBeenCalledTimes(2);
    monitor.stop();
  });

  it('сессия без подписчиков не получает снимок и не заводит ps', async () => {
    const { spawnFn, mock } = fakeSpawn({ output: psOutput([]) });
    const monitor = createProcessMonitor({ log: silentLog(), livePtys: () => [handle('s-1', 1)], spawn: spawnFn });
    await monitor.refresh();
    expect(mock).not.toHaveBeenCalled();
  });

  it('подписчик есть, живого PTY с подписчиком нет — ps не запускается', async () => {
    vi.useFakeTimers();
    const { spawnFn, mock } = fakeSpawn({ output: psOutput([]) });
    const monitor = createProcessMonitor({ log: silentLog(), livePtys: () => [handle('s-2', 1)], spawn: spawnFn });
    monitor.subscribe(ref('s-1'), () => {});
    await monitor.refresh();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    expect(mock).not.toHaveBeenCalled();
    monitor.stop();
  });
});

describe('регрессии таймера при ненулевой длительности ps', () => {
  const SLOW_MS = 500;

  it('подписчик во время опроса не удваивает цепочку: не больше 10 ps за 10 интервалов', async () => {
    vi.useFakeTimers();
    const { spawnFn, mock } = fakeSpawn({ output: psOutput([]), delayMs: SLOW_MS });
    const monitor = createProcessMonitor({ log: silentLog(), livePtys: () => [handle('s-1', 1)], spawn: spawnFn });
    monitor.subscribe(ref('s-1'), () => {});
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 100);   // первый ps идёт
    monitor.subscribe(ref('s-1'), () => {});   // подписчик приходит во время опроса
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 9 - 100);
    expect(mock.mock.calls.length).toBeLessThanOrEqual(10);
    monitor.stop();
  });

  it('refresh() во время идущего таймера и подписка во время опроса не плодят таймеры', async () => {
    vi.useFakeTimers();
    const { spawnFn } = fakeSpawn({ output: psOutput([]), delayMs: SLOW_MS });
    const monitor = createProcessMonitor({ log: silentLog(), livePtys: () => [handle('s-1', 1)], spawn: spawnFn });
    monitor.subscribe(ref('s-1'), () => {});
    const pending = monitor.refresh();
    monitor.subscribe(ref('s-1'), () => {});
    await vi.advanceTimersByTimeAsync(SLOW_MS);
    await pending;
    // Ожидающий тик ровно один (setTimeout-таймер ps уже отработал).
    expect(vi.getTimerCount()).toBe(1);
    monitor.stop();
  });

  it('stop() во время опроса: после него нет ни одного ps', async () => {
    vi.useFakeTimers();
    const { spawnFn, mock } = fakeSpawn({ output: psOutput([]), delayMs: SLOW_MS });
    const monitor = createProcessMonitor({ log: silentLog(), livePtys: () => [handle('s-1', 1)], spawn: spawnFn });
    monitor.subscribe(ref('s-1'), () => {});
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 100);
    expect(mock).toHaveBeenCalledTimes(1);
    monitor.stop();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 10);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('отписка последнего клиента во время опроса: после неё нет ни одного ps', async () => {
    vi.useFakeTimers();
    const { spawnFn, mock } = fakeSpawn({ output: psOutput([]), delayMs: SLOW_MS });
    const monitor = createProcessMonitor({ log: silentLog(), livePtys: () => [handle('s-1', 1)], spawn: spawnFn });
    const off = monitor.subscribe(ref('s-1'), () => {});
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 100);
    off();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 10);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('refresh() во время опроса ждёт его завершения, новый подписчик получает снимок', async () => {
    vi.useFakeTimers();
    const { spawnFn, mock } = fakeSpawn({ output: psOutput([[2, 1, 'zsh']]), delayMs: SLOW_MS });
    const monitor = createProcessMonitor({ log: silentLog(), livePtys: () => [handle('s-1', 1)], spawn: spawnFn });
    monitor.subscribe(ref('s-1'), () => {});
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 100);   // опрос идёт
    const late = collect();
    monitor.subscribe(ref('s-1'), late.listener);
    let done = false;
    const pending = monitor.refresh().then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(SLOW_MS - 150);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    await pending;
    expect(done).toBe(true);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(late.seen[0]?.names).toEqual(['zsh']);
    monitor.stop();
  });
});

describe('сбои ps', () => {
  it('таймаут: подписчик получает null, следующий тик работает', async () => {
    vi.useFakeTimers();
    const { spawnFn, mock } = fakeSpawn({ closes: false });
    const monitor = createProcessMonitor({ log: silentLog(), livePtys: () => [handle('s-1', 1)], spawn: spawnFn, timeoutMs: 1000 });
    const seen = collect();
    monitor.subscribe(ref('s-1'), seen.listener);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 1000);
    expect(seen.seen).toHaveLength(1);
    expect(seen.seen[0]?.snapshot).toBeNull();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 1000);
    expect(mock).toHaveBeenCalledTimes(2);
    monitor.stop();
  });

  it('ненулевой код ps: подписчик получает null', async () => {
    const { spawnFn } = fakeSpawn({ output: psOutput([[2, 1, 'zsh']]), code: 1 });
    const monitor = createProcessMonitor({ log: silentLog(), livePtys: () => [handle('s-1', 1)], spawn: spawnFn });
    const seen = collect();
    monitor.subscribe(ref('s-1'), seen.listener);
    await monitor.refresh();
    expect(seen.seen[0]?.snapshot).toBeNull();
    monitor.stop();
  });

  it('ошибка запуска ps не роняет монитор и тоже даёт null', async () => {
    const { spawnFn } = fakeSpawn({ throws: true });
    const monitor = createProcessMonitor({ log: silentLog(), livePtys: () => [handle('s-1', 1)], spawn: spawnFn });
    const seen = collect();
    monitor.subscribe(ref('s-1'), seen.listener);
    await expect(monitor.refresh()).resolves.toBeUndefined();
    expect(seen.seen[0]?.snapshot).toBeNull();
    monitor.stop();
  });

  it('снимок вышедшего PTY после опроса не рассылается', async () => {
    let live = true;
    const { spawnFn } = fakeSpawn({ output: psOutput([[2, 1, 'zsh']]), delayMs: 100 });
    vi.useFakeTimers();
    const monitor = createProcessMonitor({ log: silentLog(), livePtys: () => (live ? [handle('s-1', 1)] : []), spawn: spawnFn });
    const seen = collect();
    monitor.subscribe(ref('s-1'), seen.listener);
    const pending = monitor.refresh();
    live = false;   // PTY вышел, пока шёл ps
    await vi.advanceTimersByTimeAsync(200);
    await pending;
    expect(seen.seen).toHaveLength(0);
    monitor.stop();
  });
});
