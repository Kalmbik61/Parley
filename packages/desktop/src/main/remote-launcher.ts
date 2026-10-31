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

export interface RemoteLauncherOptions {
  paths: BridgePaths;
  /** Starts the bridge process (like `spawnHost`); `null` — it cannot be started, the reason is reported by the caller. */
  spawn: () => Promise<SpawnedHost | null>;
  createClient?: () => ControlClient;
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
      if (client.isConnected()) {
        try {
          await client.call('stop');
        } catch {
          // The bridge may close the socket while stopping; nothing more to ask.
        }
      }
      client.close();
    },
    detach() {
      client.close();
    },
  };
}
