// App runtime: ONE HostStore per app, first-run wipe, then (when a host is paired) a Supervisor and the
// remote-client store wired together. React-free; `use-runtime.ts` exposes it to components.
import {
  HostStore,
  Supervisor,
  createRemoteClient,
  type ClientInfo,
  type HostRecord,
  type HostStatus,
  type Platform,
  type RemoteClient,
  type SupervisorStatus,
} from '@parley/remote-client';
import { withSeedHost } from '../dev/seed-host';
import { wipeOnFirstRun, type InstallMarker } from '../platform/first-run';
import type { PushAvailability } from '../push/register';

export interface RuntimeState {
  phase: 'booting' | 'ready';
  host: HostRecord | null;
  supervisor: SupervisorStatus | null;
  client: RemoteClient | null;
  /** Entered `waiting`/`idle` after a failure, ms; `null` while connected or connecting for the first time. */
  waitingSince: number | null;
  /** Last time the snapshot changed, ms. */
  lastUpdatedAt: number | null;
  /** Host status from the bridge (`bridge.status`), mirrored so the banner re-renders on change. */
  hostStatus: HostStatus | null;
  /** Result of the last `push.register` (A16); Settings shows "Notifications unavailable on this build". */
  pushAvailability: PushAvailability;
}

export interface RuntimeDeps {
  platform: Platform;
  marker: InstallMarker;
  client: ClientInfo;
  /**
   * Developer build only: a host record that exists in memory only and is hidden as soon as a real record exists
   * (`withSeedHost` in `src/dev/seed-host.ts`). It is never written to the Keychain.
   */
  seedHost?: HostRecord | null;
  /** A16: runs after every transition to `ready`; resolves with what was registered. Must not throw. */
  registerPush?: (call: (method: string, params: unknown) => Promise<unknown>) => Promise<PushAvailability>;
}

export class AppRuntime {
  readonly hostStore: HostStore;
  readonly #deps: RuntimeDeps;
  readonly #listeners = new Set<() => void>();
  #state: RuntimeState = {
    phase: 'booting',
    host: null,
    supervisor: null,
    client: null,
    waitingSince: null,
    lastUpdatedAt: null,
    hostStatus: null,
    pushAvailability: 'unknown',
  };
  #started: Promise<void> | null = null;
  #supervisor: Supervisor | null = null;
  #teardown: Array<() => void> = [];

  constructor(deps: RuntimeDeps) {
    this.#deps = deps;
    this.hostStore = new HostStore(
      deps.seedHost ? withSeedHost(deps.platform.keyStore, deps.seedHost) : deps.platform.keyStore,
    );
  }

  /** Relay of the current host for the reachability probe; `null` before a host is known. */
  get relayHost(): string | null {
    return this.#state.host?.relay ?? null;
  }

  getState = (): RuntimeState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  };

  /** Idempotent. */
  start(): Promise<void> {
    this.#started ??= this.#start();
    return this.#started;
  }

  async #start(): Promise<void> {
    await wipeOnFirstRun(this.hostStore, this.#deps.marker);
    // A14 adds host selection; until then the current host is the first record (the seed is hidden once a real one exists).
    const host = (await this.hostStore.list())[0] ?? null;
    if (host === null) return this.#set({ phase: 'ready' });
    this.#connect(host);
  }

  #connect(host: HostRecord): void {
    const { platform } = this.#deps;
    const supervisor = new Supervisor(platform, this.hostStore, { hostId: host.hostId, client: this.#deps.client });
    const client = createRemoteClient({
      rpc: { call: (method, params) => supervisor.call(method, params) },
      clock: {
        now: () => platform.now(),
        setTimeout: (fn, ms) => platform.setTimeout(fn, ms),
        clearTimeout: (h) => platform.clearTimeout(h),
        setInterval: (fn, ms) => setInterval(fn, ms),
        clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
      },
    });
    this.#supervisor = supervisor;
    this.#teardown.push(
      supervisor.onEvent((event, data) => client.handleEvent(event, data)),
      client.store.subscribe((next, prev) => {
        if (next.snapshot !== prev.snapshot) this.#set({ lastUpdatedAt: platform.now() });
        if (next.hostStatus !== prev.hostStatus) this.#set({ hostStatus: next.hostStatus });
      }),
      platform.appState.subscribe((s) => client.refresher.setForeground(s === 'active')),
      supervisor.subscribe((status) => {
        const ready = status.state === 'ready';
        if (ready && this.#state.supervisor?.state !== 'ready') this.registerPush();
        client.refresher.setConnected(ready);
        client.setBridgeMethods(ready ? (status.hello?.methods ?? null) : null);
        const failing = status.state === 'waiting' || status.state === 'offline';
        this.#set({
          supervisor: status,
          waitingSince: failing ? (this.#state.waitingSince ?? platform.now()) : null,
        });
      }),
      () => client.dispose(),
    );
    this.#set({ phase: 'ready', host, supervisor: supervisor.status, client });
    supervisor.start();
  }

  /** Make `hostId` the current host (push tap, host switcher). No-op if it already is; `false` if unknown. */
  async selectHost(hostId: string): Promise<boolean> {
    await this.start();
    if (this.#state.host?.hostId === hostId) return true;
    const host = (await this.hostStore.list()).find((h) => h.hostId === hostId);
    if (!host) return false;
    this.#supervisor?.stop();
    this.#supervisor = null;
    for (const off of this.#teardown.splice(0)) off();
    this.#set({ supervisor: null, waitingSince: null, lastUpdatedAt: null, hostStatus: null, pushAvailability: 'unknown' });
    this.#connect(host);
    return true;
  }

  /** A later `start()` begins again (remounting the root, Fast Refresh). */
  stop(): void {
    this.#started = null;
    this.#supervisor?.stop();
    this.#supervisor = null;
    for (const off of this.#teardown.splice(0)) off();
  }

  /** `push.register` now if connected (after `ready`, and when APNs hands out a new token). */
  registerPush(): void {
    const supervisor = this.#supervisor;
    if (!supervisor || supervisor.status.state !== 'ready' || !this.#deps.registerPush) return;
    void this.#deps.registerPush((m, p) => supervisor.call(m, p)).then((pushAvailability) => this.#set({ pushAvailability }));
  }

  /** A read-only bridge call for screens (e.g. `context.letter`); rejects when not connected. */
  call(method: string, params?: unknown): Promise<unknown> {
    if (!this.#supervisor) return Promise.reject(new Error('not connected'));
    return this.#supervisor.call(method, params);
  }

  /** "Retry" on the banner. */
  retry(): void {
    this.#supervisor?.refresh();
  }

  #set(patch: Partial<RuntimeState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const l of [...this.#listeners]) l();
  }
}
