// App runtime: ONE HostStore per app, first-run wipe, then (when a host is paired) a Supervisor and the
// remote-client store wired together. React-free; `use-runtime.ts` exposes it to components.
import {
  HostStore,
  Supervisor,
  createRemoteClient,
  type ClientInfo,
  type HostRecord,
  type Platform,
  type RemoteClient,
  type SupervisorStatus,
} from '@parley/remote-client';
import { wipeOnFirstRun, type InstallMarker } from '../platform/first-run';

export interface RuntimeState {
  phase: 'booting' | 'ready';
  host: HostRecord | null;
  supervisor: SupervisorStatus | null;
  client: RemoteClient | null;
  /** Entered `waiting`/`idle` after a failure, ms; `null` while connected or connecting for the first time. */
  waitingSince: number | null;
  /** Last time the snapshot changed, ms. */
  lastUpdatedAt: number | null;
}

export interface RuntimeDeps {
  platform: Platform;
  marker: InstallMarker;
  client: ClientInfo;
  /** Developer build only: a host record to use when none is paired (see `src/dev/seed-host.ts`). */
  seedHost?: () => HostRecord | null;
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
  };
  #started: Promise<void> | null = null;
  #supervisor: Supervisor | null = null;
  #teardown: Array<() => void> = [];

  constructor(deps: RuntimeDeps) {
    this.#deps = deps;
    this.hostStore = new HostStore(deps.platform.keyStore);
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
    let hosts = await this.hostStore.list();
    if (hosts.length === 0) {
      const seed = this.#deps.seedHost?.() ?? null;
      if (seed !== null) {
        await this.hostStore.put(seed);
        hosts = await this.hostStore.list();
      }
    }
    const host = hosts[0] ?? null;
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
      }),
      platform.appState.subscribe((s) => client.refresher.setForeground(s === 'active')),
      supervisor.subscribe((status) => {
        const ready = status.state === 'ready';
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

  stop(): void {
    this.#supervisor?.stop();
    this.#supervisor = null;
    for (const off of this.#teardown.splice(0)) off();
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
