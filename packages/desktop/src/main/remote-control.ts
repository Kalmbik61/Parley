import { readFile } from 'node:fs/promises';
import net from 'node:net';
import { LineDecoder } from '@parley/protocol';

/** Refusal from the bridge (`stale_request`, `not_ready`, …) — the code reaches the window as is. */
export class ControlCallError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ControlCallError';
  }
}

export interface ControlClient {
  /** Connects, reads `control.token` and sends `hello`; rejects if the socket is not there. */
  connect(): Promise<void>;
  isConnected(): boolean;
  call(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
  onEvent(listener: (event: string, data: unknown) => void): () => void;
  onClose(listener: () => void): () => void;
  close(): void;
}

export interface ControlClientOptions {
  socketPath: string;
  tokenPath: string;
  /** Tests substitute the transport. */
  connectSocket?: (path: string) => net.Socket;
}

/** Client of the bridge control socket (spec 5.3): NDJSON, first frame `hello {token}`, then `{id, method, params}`. */
export function createControlClient(options: ControlClientOptions): ControlClient {
  const events = new Set<(event: string, data: unknown) => void>();
  const closers = new Set<() => void>();
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  let socket: net.Socket | null = null;
  let connected = false;
  let nextId = 1;
  let connecting: Promise<void> | null = null;

  function failAll(error: Error): void {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }

  function request(target: net.Socket, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new ControlCallError('timeout', `${method} timed out`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      target.write(`${JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) })}\n`);
    });
  }

  function onData(decoder: LineDecoder, chunk: Buffer): void {
    let messages: unknown[];
    try {
      messages = decoder.push(chunk);
    } catch {
      socket?.destroy();
      return;
    }
    for (const raw of messages) {
      if (typeof raw !== 'object' || raw === null) continue;
      const msg = raw as { id?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown }; event?: unknown; data?: unknown };
      if (typeof msg.event === 'string') {
        for (const listener of events) listener(msg.event, msg.data);
        continue;
      }
      if (typeof msg.id !== 'number') continue;
      const entry = pending.get(msg.id);
      if (!entry) continue;
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) {
        entry.reject(
          new ControlCallError(
            typeof msg.error.code === 'string' ? msg.error.code : 'failed',
            typeof msg.error.message === 'string' ? msg.error.message : 'failed',
          ),
        );
      } else {
        entry.resolve(msg.result);
      }
    }
  }

  return {
    connect() {
      if (connected) return Promise.resolve();
      // Two callers share one attempt: a second socket would replace the first.
      connecting ??= connectOnce().finally(() => {
        connecting = null;
      });
      return connecting;
    },
    isConnected: () => connected,
    call(method, params, timeoutMs = 10_000) {
      if (!socket || !connected) return Promise.reject(new ControlCallError('closed', 'not connected to the bridge'));
      return request(socket, method, params, timeoutMs);
    },
    onEvent(listener) {
      events.add(listener);
      return () => events.delete(listener);
    },
    onClose(listener) {
      closers.add(listener);
      return () => closers.delete(listener);
    },
    close() {
      connected = false;
      socket?.destroy();
      socket = null;
    },
  };

  async function connectOnce(): Promise<void> {
    {
      const token = (await readFile(options.tokenPath, 'utf8')).trim();
      const created = (options.connectSocket ?? net.connect)(options.socketPath);
      await new Promise<void>((resolve, reject) => {
        created.once('connect', resolve);
        created.once('error', reject);
      });
      const decoder = new LineDecoder();
      socket = created;
      created.on('data', (chunk: Buffer) => onData(decoder, chunk));
      created.on('error', () => {});
      created.once('close', () => {
        const was = connected;
        connected = false;
        if (socket === created) socket = null;
        failAll(new ControlCallError('closed', 'control socket closed'));
        if (was) for (const listener of closers) listener();
      });
      try {
        await request(created, 'hello', { token }, 5000);
      } catch (error) {
        created.destroy();
        throw error;
      }
      connected = true;
    }
  }
}

export type PresenceState = 'active' | 'idle' | 'locked';

/** The part of Electron's `powerMonitor` that presence needs. */
export interface PowerMonitorLike {
  getSystemIdleState(idleThresholdSeconds: number): 'active' | 'idle' | 'locked' | 'unknown';
  on(event: 'lock-screen' | 'unlock-screen', listener: () => void): unknown;
  off?(event: 'lock-screen' | 'unlock-screen', listener: () => void): unknown;
}

export const PRESENCE_POLL_MS = 15_000;
export const PRESENCE_IDLE_SECONDS = 60;

/**
 * Presence for the bridge (spec 9.3): `getSystemIdleState(60)` every 15 s and on a change, plus
 * `lock-screen` / `unlock-screen`. `send` is called on a change; `resend()` sends the current state
 * again (after a reconnect to the bridge).
 */
export function startPresence(options: {
  powerMonitor: PowerMonitorLike;
  send: (state: PresenceState) => void;
  pollMs?: number;
}): { resend(): void; stop(): void } {
  const { powerMonitor } = options;
  let locked = false;
  let last: PresenceState | null = null;

  const current = (): PresenceState => {
    if (locked) return 'locked';
    const idle = powerMonitor.getSystemIdleState(PRESENCE_IDLE_SECONDS);
    return idle === 'locked' ? 'locked' : idle === 'idle' ? 'idle' : 'active';
  };
  const check = (force: boolean): void => {
    const next = current();
    if (!force && next === last) return;
    last = next;
    options.send(next);
  };
  const onLock = (): void => {
    locked = true;
    check(false);
  };
  const onUnlock = (): void => {
    locked = false;
    check(false);
  };
  powerMonitor.on('lock-screen', onLock);
  powerMonitor.on('unlock-screen', onUnlock);
  const timer = setInterval(() => check(false), options.pollMs ?? PRESENCE_POLL_MS);
  timer.unref();
  check(true);
  return {
    resend: () => check(true),
    stop() {
      clearInterval(timer);
      powerMonitor.off?.('lock-screen', onLock);
      powerMonitor.off?.('unlock-screen', onUnlock);
    },
  };
}
