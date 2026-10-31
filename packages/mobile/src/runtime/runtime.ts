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
import type { LocalSettings } from '../settings/local-settings';

export interface RuntimeState {
  phase: 'booting' | 'ready';
  /** The current Mac. */
  host: HostRecord | null;
  /** Every paired Mac (the dev seed only while no real record exists). */
  hosts: HostRecord[];
  /** Names the person gave to Macs on this phone, by host id. */
  hostNames: Record<string, string>;
  supervisor: SupervisorStatus | null;
  client: RemoteClient | null;
  /** Entered `waiting`/`idle` after a failure, ms; `null` while connected or connecting for the first time. */
  waitingSince: number | null;
  /** Last time the snapshot changed, ms. */
  lastUpdatedAt: number | null;
  /** Host status from the bridge (`bridge.status`), mirrored so the banner re-renders on change. */
  hostStatus: HostStatus | null;
}

export interface RuntimeDeps {
  platform: Platform;
  marker: InstallMarker;
  client: ClientInfo;
  settings: LocalSettings;
  /**
   * Developer build only: a host record that exists in memory only and is hidden as soon as a real record exists
   * (`withSeedHost` in `src/dev/seed-host.ts`). It is never written to the Keychain.
   */
  seedHost?: HostRecord | null;
}

export class AppRuntime {
  readonly hostStore: HostStore;
  get platform(): Platform {
    return this.#deps.platform;
  }
  readonly #deps: RuntimeDeps;
  readonly #listeners = new Set<() => void>();
  #state: RuntimeState = {
    phase: 'booting',
    host: null,
    hosts: [],
    hostNames: {},
    supervisor: null,
    client: null,
    waitingSince: null,
    lastUpdatedAt: null,
    hostStatus: null,
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
    const [hosts, hostNames, currentId] = await Promise.all([
      this.hostStore.list(),
      this.#deps.settings.hostNames(),
      this.#deps.settings.currentHostId(),
    ]);
    // The remembered Mac, else the first record (the dev seed is hidden once a real record exists).
    const host = hosts.find((h) => h.hostId === currentId) ?? hosts[0] ?? null;
    this.#set({ hosts, hostNames });
    if (host === null) return this.#set({ phase: 'ready' });
    this.#connect(host);
  }

  /** Make a paired Mac the current one and reconnect (Settings → Macs). */
  async selectHost(hostId: string): Promise<void> {
    const host = this.#state.hosts.find((h) => h.hostId === hostId);
    if (!host || host.hostId === this.#state.host?.hostId) return;
    await this.#deps.settings.setCurrentHostId(hostId);
    this.#disconnect();
    this.#connect(host);
  }

  /** A pairing just finished: the new record becomes the current Mac. */
  async adoptPaired(record: HostRecord): Promise<void> {
    const hosts = await this.hostStore.list();
    await this.#deps.settings.setCurrentHostId(record.hostId);
    this.#disconnect();
    this.#set({ hosts });
    this.#connect(hosts.find((h) => h.hostId === record.hostId) ?? record);
  }

  /** Erase a Mac's keys from this phone. The Mac still lists the phone until it is revoked there (spec §7.9). */
  async removeHost(hostId: string): Promise<void> {
    await this.hostStore.remove(hostId);
    await this.#deps.settings.forgetHost(hostId);
    const hosts = await this.hostStore.list();
    const hostNames = await this.#deps.settings.hostNames();
    if (this.#state.host?.hostId !== hostId) return this.#set({ hosts, hostNames });
    this.#disconnect();
    this.#set({ hosts, hostNames });
    const next = hosts[0] ?? null;
    if (next === null) return;
    await this.#deps.settings.setCurrentHostId(next.hostId);
    this.#connect(next);
  }

  /** The name only this phone shows; empty — back to the Mac's own name. */
  async renameHost(hostId: string, name: string): Promise<void> {
    await this.#deps.settings.setHostName(hostId, name);
    this.#set({ hostNames: await this.#deps.settings.hostNames() });
  }

  /** Round trip of one `ping`, ms; `null` when not connected or the call failed. */
  async measureRtt(): Promise<number | null> {
    const supervisor = this.#supervisor;
    if (supervisor === null || supervisor.status.state !== 'ready') return null;
    const started = this.#deps.platform.now();
    try {
      await supervisor.call('ping', {}, 5000);
      return this.#deps.platform.now() - started;
    } catch {
      return null;
    }
  }

  requireBiometric(): Promise<boolean> {
    return this.#deps.settings.requireBiometric();
  }

  setRequireBiometric(on: boolean): Promise<void> {
    return this.#deps.settings.setRequireBiometric(on);
  }

  notificationsEnabled(): Promise<boolean> {
    return this.#deps.settings.notificationsEnabled();
  }

  setNotificationsEnabled(on: boolean): Promise<void> {
    return this.#deps.settings.setNotificationsEnabled(on);
  }

  /** "Reconnect" in Diagnostics. */
  reconnect(): void {
    this.#supervisor?.refresh();
  }

  #disconnect(): void {
    this.#supervisor?.stop();
    this.#supervisor = null;
    for (const off of this.#teardown.splice(0)) off();
    this.#set({
      host: null,
      supervisor: null,
      client: null,
      waitingSince: null,
      lastUpdatedAt: null,
      hostStatus: null,
    });
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

  /** A later `start()` begins again (remounting the root, Fast Refresh). */
  stop(): void {
    this.#started = null;
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
