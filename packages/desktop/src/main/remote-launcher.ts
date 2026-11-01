import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parleyHome } from '@parley/core';
import type { SpawnedHost } from './host-connection.js';
import { createControlClient, type ControlClient } from './remote-control.js';

const require = createRequire(import.meta.url);

/**
 * Paths of the bridge (`remotePaths()` of `@parley/remote`, spec 5.2), computed here without importing the
 * package: the window only needs the file names, and the bridge code runs in its own process.
 */
export interface BridgePaths {
  dir: string;
  controlSocket: string;
  controlToken: string;
  pid: string;
  log: string;
}

export function bridgePaths(home: string = parleyHome()): BridgePaths {
  const dir = path.join(home, 'remote');
  return {
    dir,
    controlSocket: path.join(dir, 'control.sock'),
    controlToken: path.join(dir, 'control.token'),
    pid: path.join(dir, 'bridge.pid'),
    log: path.join(dir, 'bridge.log'),
  };
}

/**
 * Entry of the bridge process. In `.app` it is `Resources/remote/dist/main.js` (A23 ships it there);
 * in dev it is the workspace package `@parley/remote` (A22 adds `exports["./main"]`).
 */
export function resolveBridgeEntry(options: { packaged: boolean; resourcesPath: string }): string {
  if (options.packaged) return path.join(options.resourcesPath, 'remote', 'dist', 'main.js');
  return require.resolve('@parley/remote/main');
}

/** What the launcher needs to find and end a bridge it has no control socket to (spec 5.1: the bridge outlives the window). */
export interface BridgeProcesses {
  /** pid from `bridge.pid`, `null` — no file. */
  readPid(): Promise<number | null>;
  /** Is this pid a bridge process? A stale pid file may name an unrelated process. */
  isBridge(pid: number): Promise<boolean>;
  alive(pid: number): boolean;
  signal(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void;
}

export function systemBridgeProcesses(pidFile: string): BridgeProcesses {
  return {
    async readPid() {
      const pid = Number((await readFile(pidFile, 'utf8').catch(() => '')).trim());
      return Number.isInteger(pid) && pid > 1 ? pid : null;
    },
    isBridge: (pid) =>
      new Promise((resolve) => {
        execFile('ps', ['-p', String(pid), '-o', 'command='], (error, stdout) => resolve(error === null && /remote[\\/](dist[\\/])?main\.js|parley-remote/.test(stdout)));
      }),
    alive(pid) {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    signal(pid, signal) {
      try {
        process.kill(pid, signal);
      } catch {
        // Already gone.
      }
    },
  };
}

export interface RemoteLauncherOptions {
  paths: BridgePaths;
  /** Starts the bridge process (like `spawnHost`); `null` — it cannot be started, the reason is reported by the caller. */
  spawn: () => Promise<SpawnedHost | null>;
  createClient?: () => ControlClient;
  processes?: BridgeProcesses;
  /** How long a bridge without a control socket gets to exit on SIGTERM before SIGKILL. */
  killGraceMs?: number;
  startTimeoutMs?: number;
  pollMs?: number;
}

export interface RemoteLauncher {
  readonly client: ControlClient;
  /** Connects to a running bridge, or starts one and waits for its control socket. */
  start(): Promise<void>;
  /** Asks the running bridge to stop through the control socket and disconnects. */
  stop(): Promise<void>;
  /** Disconnects without stopping the bridge (window quit: the bridge outlives the window). */
  detach(): void;
}

export function createRemoteLauncher(options: RemoteLauncherOptions): RemoteLauncher {
  const client =
    options.createClient?.() ??
    createControlClient({ socketPath: options.paths.controlSocket, tokenPath: options.paths.controlToken });
  const timeoutMs = options.startTimeoutMs ?? 10_000;
  const pollMs = options.pollMs ?? 100;
  const processes = options.processes ?? systemBridgeProcesses(options.paths.pid);
  const killGraceMs = options.killGraceMs ?? 3000;
  let spawned: SpawnedHost | null = null;
  let starting: Promise<void> | null = null;

  async function tryConnect(): Promise<boolean> {
    try {
      await client.connect();
      return true;
    } catch {
      return false;
    }
  }

  async function doStart(): Promise<void> {
    if (client.isConnected() || (await tryConnect())) return;
    // A process started earlier and still alive is given time instead of a second one (like the host).
    if (!spawned?.isRunning()) {
      spawned = await options.spawn();
      if (spawned === null) throw new Error('The bridge could not be started');
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      if (await tryConnect()) return;
      if (!spawned.isRunning()) break;
    }
    throw new Error('The bridge did not start');
  }

  return {
    client,
    start() {
      starting ??= doStart().finally(() => {
        starting = null;
      });
      return starting;
    },
    async stop() {
      // The window may not be connected (a start still in flight, a dropped socket, a bridge left by an earlier
      // window): connect first, so `stop` reaches it; with no control socket end the process by `bridge.pid`.
      if (!client.isConnected()) await tryConnect();
      if (client.isConnected()) {
        try {
          await client.call('stop');
        } catch {
          // The bridge may close the socket while stopping; nothing more to ask.
        }
        client.close();
        return;
      }
      client.close();
      const pid = await processes.readPid();
      if (pid === null || !(await processes.isBridge(pid))) return;
      processes.signal(pid, 'SIGTERM');
      const deadline = Date.now() + killGraceMs;
      while (processes.alive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, pollMs));
      if (processes.alive(pid)) processes.signal(pid, 'SIGKILL');
    },
    detach() {
      client.close();
    },
  };
}
