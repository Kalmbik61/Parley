import net from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LineDecoder } from '@parley/protocol';
import { bridgeEntryVersion, bridgePaths, createRemoteLauncher, resolveBridgeEntry } from './remote-launcher.js';
import type { BridgeProcesses } from './remote-launcher.js';
import { createControlClient, startPresence, type PowerMonitorLike } from './remote-control.js';

/** A stub of the bridge: the control socket of spec 5.3 — token file, `hello`, `stop`, a few methods, events. */
async function stubBridge(dir: string, token: string) {
  const paths = bridgePaths(dir);
  const calls: Array<{ method: string; params: unknown }> = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    const decoder = new LineDecoder();
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', (chunk: Buffer) => {
      for (const raw of decoder.push(chunk) as Array<{ id: number; method: string; params?: { token?: string } }>) {
        if (raw.method === 'hello') {
          if (raw.params?.token !== token) {
            socket.write(`${JSON.stringify({ id: raw.id, error: { code: 'unauthorized', message: 'invalid token' } })}\n`);
            socket.end();
          } else socket.write(`${JSON.stringify({ id: raw.id, result: { ok: true } })}\n`);
          continue;
        }
        calls.push({ method: raw.method, params: raw.params });
        if (raw.method === 'pair.answer') {
          socket.write(`${JSON.stringify({ id: raw.id, error: { code: 'stale_request', message: 'stale_request' } })}\n`);
        } else socket.write(`${JSON.stringify({ id: raw.id, result: { ok: true } })}\n`);
        if (raw.method === 'stop') setTimeout(() => socket.end(), 5);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(paths.controlSocket, resolve));
  await writeFile(paths.controlToken, token);
  return {
    paths,
    calls,
    emit: (event: string, data: unknown) => {
      for (const socket of sockets) socket.write(`${JSON.stringify({ event, data })}\n`);
    },
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}

let dir: string;
beforeEach(async () => {
  // Short path: sockaddr_un is 104 bytes on macOS.
  dir = await mkdtemp(path.join(tmpdir(), 'rl-'));
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.join(dir, 'remote'), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('bridge paths', () => {
  it('mirror the layout of the bridge (spec 5.2)', () => {
    const paths = bridgePaths('/h');
    expect(paths.controlSocket).toBe('/h/remote/control.sock');
    expect(paths.controlToken).toBe('/h/remote/control.token');
  });

  it('resolves the dev entry through the workspace package @parley/remote', () => {
    expect(resolveBridgeEntry({ packaged: false, resourcesPath: '/R' })).toMatch(/packages\/remote\/dist\/main\.js$/);
  });

  it('resolves the packaged entry under Resources/remote', () => {
    expect(resolveBridgeEntry({ packaged: true, resourcesPath: '/R' })).toBe('/R/remote/dist/main.js');
  });
});

describe('remote launcher', () => {
  it('starts a bridge when none is running, waits for its socket and stops it by the control socket', async () => {
    const paths = bridgePaths(dir);
    let stub: Awaited<ReturnType<typeof stubBridge>> | null = null;
    let spawns = 0;
    const launcher = createRemoteLauncher({
      paths,
      pollMs: 10,
      spawn: async () => {
        spawns += 1;
        // The "process" opens its control socket a little later.
        setTimeout(() => void stubBridge(dir, 'tok').then((s) => (stub = s)), 30);
        return { isRunning: () => true };
      },
    });
    await launcher.start();
    expect(spawns).toBe(1);
    expect(launcher.client.isConnected()).toBe(true);
    await launcher.stop();
    expect(stub!.calls.map((call) => call.method)).toEqual(['stop']);
    expect(launcher.client.isConnected()).toBe(false);
    await stub!.close();
  });

  it('attaches to a bridge that is already running without spawning another', async () => {
    const stub = await stubBridge(dir, 'tok');
    let spawns = 0;
    const launcher = createRemoteLauncher({
      paths: stub.paths,
      pollMs: 10,
      spawn: async () => {
        spawns += 1;
        return null;
      },
    });
    await launcher.start();
    expect(spawns).toBe(0);
    launcher.detach();
    await stub.close();
  });

  it('fails when the process cannot be spawned or dies without a socket', async () => {
    const paths = bridgePaths(dir);
    await expect(createRemoteLauncher({ paths, spawn: async () => null }).start()).rejects.toThrow(/could not be started/);
    await expect(
      createRemoteLauncher({ paths, pollMs: 5, startTimeoutMs: 200, spawn: async () => ({ isRunning: () => false }) }).start(),
    ).rejects.toThrow(/did not start/);
  });
});

describe('remote launcher: stop without a connection', () => {
  it('connects first so that `stop` reaches a bridge the window is not connected to', async () => {
    const stub = await stubBridge(dir, 'tok');
    const launcher = createRemoteLauncher({ paths: stub.paths, spawn: async () => null });
    expect(launcher.client.isConnected()).toBe(false);
    await launcher.stop();
    expect(stub.calls.map((call) => call.method)).toEqual(['stop']);
    await stub.close();
  });

  function processes(options: { pid: number | null; bridge: boolean; diesOnTerm: boolean }) {
    const signals: string[] = [];
    let alive = true;
    const fake: BridgeProcesses = {
      readPid: async () => options.pid,
      isBridge: async () => options.bridge,
      alive: () => alive,
      signal: (_pid, signal) => {
        signals.push(signal);
        if (signal === 'SIGKILL' || options.diesOnTerm) alive = false;
      },
    };
    return { fake, signals };
  }

  it('with no control socket ends the process named by bridge.pid: SIGTERM, then SIGKILL after the grace period', async () => {
    const p = processes({ pid: 4242, bridge: true, diesOnTerm: false });
    await createRemoteLauncher({ paths: bridgePaths(dir), spawn: async () => null, processes: p.fake, pollMs: 5, killGraceMs: 30 }).stop();
    expect(p.signals).toEqual(['SIGTERM', 'SIGKILL']);
    const quick = processes({ pid: 4242, bridge: true, diesOnTerm: true });
    await createRemoteLauncher({ paths: bridgePaths(dir), spawn: async () => null, processes: quick.fake, pollMs: 5, killGraceMs: 30 }).stop();
    expect(quick.signals).toEqual(['SIGTERM']);
  });

  it('does not signal a pid that is not a bridge, or when there is no pid file', async () => {
    const stranger = processes({ pid: 4242, bridge: false, diesOnTerm: true });
    await createRemoteLauncher({ paths: bridgePaths(dir), spawn: async () => null, processes: stranger.fake }).stop();
    const none = processes({ pid: null, bridge: true, diesOnTerm: true });
    await createRemoteLauncher({ paths: bridgePaths(dir), spawn: async () => null, processes: none.fake }).stop();
    expect(stranger.signals).toEqual([]);
    expect(none.signals).toEqual([]);
  });
});

describe('control client', () => {
  it('two concurrent connect() calls share one socket', async () => {
    const stub = await stubBridge(dir, 'tok');
    const client = createControlClient({ socketPath: stub.paths.controlSocket, tokenPath: stub.paths.controlToken });
    await Promise.all([client.connect(), client.connect()]);
    expect(client.isConnected()).toBe(true);
    client.close();
    await stub.close();
  });

  it('rejects a wrong token', async () => {
    const stub = await stubBridge(dir, 'right');
    await writeFile(stub.paths.controlToken, 'wrong');
    const client = createControlClient({ socketPath: stub.paths.controlSocket, tokenPath: stub.paths.controlToken });
    await expect(client.connect()).rejects.toMatchObject({ code: 'unauthorized' });
    await stub.close();
  });

  it('keeps the refusal code of the bridge and delivers events', async () => {
    const stub = await stubBridge(dir, 'tok');
    const client = createControlClient({ socketPath: stub.paths.controlSocket, tokenPath: stub.paths.controlToken });
    await client.connect();
    const seen: Array<[string, unknown]> = [];
    client.onEvent((event, data) => seen.push([event, data]));
    await expect(client.call('pair.answer', { requestId: 'r', allow: true })).rejects.toMatchObject({ code: 'stale_request' });
    stub.emit('pair.offerClosed', { reason: 'bad-psk' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(seen).toEqual([['pair.offerClosed', { reason: 'bad-psk' }]]);
    client.close();
    await stub.close();
  });
});

describe('presence', () => {
  function monitor() {
    const listeners = new Map<string, () => void>();
    let idle: 'active' | 'idle' | 'locked' | 'unknown' = 'active';
    const thresholds: number[] = [];
    const fake: PowerMonitorLike = {
      getSystemIdleState: (seconds) => {
        thresholds.push(seconds);
        return idle;
      },
      on: (event, listener) => void listeners.set(event, listener),
    };
    return { fake, listeners, thresholds, setIdle: (next: typeof idle) => (idle = next) };
  }

  it('sends on start, on a change at the 15 s poll and on lock / unlock', async () => {
    const m = monitor();
    const sent: string[] = [];
    const presence = startPresence({ powerMonitor: m.fake, send: (state) => sent.push(state), pollMs: 10 });
    expect(sent).toEqual(['active']);
    m.setIdle('idle');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sent).toEqual(['active', 'idle']);
    m.listeners.get('lock-screen')?.();
    expect(sent.at(-1)).toBe('locked');
    m.listeners.get('unlock-screen')?.();
    expect(sent.at(-1)).toBe('idle');
    expect(new Set(m.thresholds)).toEqual(new Set([60]));
    presence.stop();
  });
});

describe('remote launcher: bridge version after an update', () => {
  /** A fake bridge + control client: `up` is whether the control socket answers, `version` what `status` reports. */
  function fakeWorld(initial: { version?: string; stopWorks?: boolean; pid?: number; statusFails?: boolean; lingerPolls?: number }) {
    const world = { up: true, version: initial.version, stopWorks: initial.stopWorks ?? true, calls: [] as string[], spawns: 0, signals: [] as string[], alive: true, order: [] as string[], lingerLeft: initial.lingerPolls ?? 0 };
    let connected = false;
    const client = {
      connect: async () => {
        if (!world.up) throw new Error('ECONNREFUSED');
        connected = true;
      },
      isConnected: () => connected,
      call: async (method: string) => {
        world.calls.push(method);
        if (method === 'status' && initial.statusFails) throw new Error('timeout');
        if (method === 'stop') world.order.push('stop');
        if (method === 'status') return world.version === undefined ? { running: true } : { running: true, version: world.version };
        if (method === 'stop' && world.stopWorks) world.up = false;
        return { ok: true };
      },
      onEvent: () => () => {},
      onClose: () => () => {},
      close: () => {
        connected = false;
      },
    };
    const processes: BridgeProcesses = {
      readPid: async () => initial.pid ?? 4242,
      isBridge: async () => true,
      alive: () => {
        if (world.signals.includes('SIGKILL')) return world.lingerLeft-- > 0;
        return world.alive && (world.up || !world.stopWorks);
      },
      signal: (_pid, signal) => {
        world.signals.push(signal);
        if (signal === 'SIGKILL') {
          world.up = false;
          world.alive = false;
        }
      },
    };
    const logs: string[] = [];
    const make = (expected: string | null, newVersion = expected ?? undefined) =>
      createRemoteLauncher({
        paths: bridgePaths(dir),
        createClient: () => client,
        processes,
        pollMs: 2,
        killGraceMs: 30,
        expectedVersion: () => expected,
        log: (m) => logs.push(m),
        spawn: async () => {
          world.spawns += 1;
          world.order.push(world.up || world.lingerLeft > 0 ? 'spawn-while-old-alive' : 'spawn');
          world.up = true;
          world.alive = true;
          world.version = newVersion;
          return { isRunning: () => true };
        },
      });
    return { world, make, logs };
  }

  it('same version: reuses the running bridge', async () => {
    const { world, make } = fakeWorld({ version: '0.29.0' });
    await make('0.29.0').start();
    expect(world.spawns).toBe(0);
    expect(world.calls).toEqual(['status']);
  });

  it('different version: stops the old bridge, starts the bundled one and logs both versions', async () => {
    const { world, make, logs } = fakeWorld({ version: '0.28.3' });
    await make('0.29.0').start();
    expect(world.calls).toContain('stop');
    expect(world.spawns).toBe(1);
    expect(world.version).toBe('0.29.0');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('0.28.3');
    expect(logs[0]).toContain('0.29.0');
  });

  it('status succeeds without a version: counts as a mismatch', async () => {
    const { world, make } = fakeWorld({ version: undefined });
    await make('0.29.0').start();
    expect(world.spawns).toBe(1);
  });

  it('a failed status call keeps a healthy bridge and logs it', async () => {
    const { world, make, logs } = fakeWorld({ version: '0.29.0', statusFails: true });
    await make('0.29.0').start();
    expect(world.spawns).toBe(0);
    expect(world.calls).toEqual(['status']);
    expect(logs).toHaveLength(1);
  });

  it('spawns only after the old bridge is gone', async () => {
    const { world, make } = fakeWorld({ version: '0.28.3' });
    await make('0.29.0').start();
    expect(world.order).toEqual(['stop', 'spawn']);
  });

  it('after SIGKILL waits until the pid is gone before spawning', async () => {
    const { world, make } = fakeWorld({ version: '0.28.3', stopWorks: false, lingerPolls: 4 });
    await make('0.29.0').start();
    expect(world.lingerLeft).toBeLessThanOrEqual(0);
    expect(world.order.at(-1)).toBe('spawn');
  });

  it('a stop that does not take effect falls back to SIGTERM and SIGKILL', async () => {
    const { world, make } = fakeWorld({ version: '0.28.3', stopWorks: false });
    await make('0.29.0').start();
    expect(world.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(world.spawns).toBe(1);
  });

  it('restarts at most once per launch: a new bridge that still mismatches is kept with a warning', async () => {
    const { world, make, logs } = fakeWorld({ version: '0.28.3' });
    const launcher = make('0.29.0', '0.28.9');
    await launcher.start();
    expect(world.spawns).toBe(1);
    expect(logs.some((m) => m.includes('warning'))).toBe(true);
    launcher.detach();
    await launcher.start();
    expect(world.spawns).toBe(1);
    expect(world.calls.filter((c) => c === 'stop')).toHaveLength(1);
  });

  it('no expected version: behaviour is unchanged', async () => {
    const { world, make } = fakeWorld({ version: '0.28.3' });
    await make(null).start();
    expect(world.spawns).toBe(0);
    expect(world.calls).toEqual([]);
  });
});

describe('bridgeEntryVersion', () => {
  it('reads package.json one level above the entry folder (packaged and workspace layouts)', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.join(dir, 'pkg', 'dist'), { recursive: true });
    await writeFile(path.join(dir, 'pkg', 'package.json'), JSON.stringify({ version: '0.29.0' }));
    expect(bridgeEntryVersion(path.join(dir, 'pkg', 'dist', 'main.js'))).toBe('0.29.0');
  });

  it('is null when package.json is missing, unreadable or has no version', async () => {
    const { mkdir } = await import('node:fs/promises');
    expect(bridgeEntryVersion(path.join(dir, 'none', 'dist', 'main.js'))).toBeNull();
    await mkdir(path.join(dir, 'bad', 'dist'), { recursive: true });
    await writeFile(path.join(dir, 'bad', 'package.json'), '{not json');
    expect(bridgeEntryVersion(path.join(dir, 'bad', 'dist', 'main.js'))).toBeNull();
    await mkdir(path.join(dir, 'nov', 'dist'), { recursive: true });
    await writeFile(path.join(dir, 'nov', 'package.json'), '{}');
    expect(bridgeEntryVersion(path.join(dir, 'nov', 'dist', 'main.js'))).toBeNull();
  });
});
