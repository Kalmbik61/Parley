// Settings that live only on this phone (D1 §11): the Face ID switch, which Mac is current, the names the person gave
// to Macs, and whether the app asks iOS to show notifications. One JSON blob in the Keychain; the bridge and the Mac
// know nothing about it. A16 reads `requireBiometric()` for the approve gate.
import type { SecureStoreLike } from '../platform/key-store';

export const SETTINGS_KEY = 'parley.settings';

interface Stored {
  requireBiometric: boolean;
  notifications: boolean;
  currentHostId: string | null;
  hostNames: Record<string, string>;
}

const DEFAULTS: Stored = { requireBiometric: true, notifications: true, currentHostId: null, hostNames: {} };
export const HOST_NAME_MAX = 64;

export class LocalSettings {
  readonly #store: SecureStoreLike;
  readonly #options: object;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(store: SecureStoreLike, options: object = {}) {
    this.#store = store;
    this.#options = options;
  }

  async #read(): Promise<Stored> {
    const raw = await this.#store.getItemAsync(SETTINGS_KEY, this.#options);
    if (raw === null) return { ...DEFAULTS, hostNames: {} };
    try {
      const p = JSON.parse(raw) as Partial<Stored>;
      const names: Record<string, string> = {};
      if (p.hostNames && typeof p.hostNames === 'object') {
        for (const [id, name] of Object.entries(p.hostNames)) if (typeof name === 'string') names[id] = name;
      }
      return {
        requireBiometric: typeof p.requireBiometric === 'boolean' ? p.requireBiometric : DEFAULTS.requireBiometric,
        notifications: typeof p.notifications === 'boolean' ? p.notifications : DEFAULTS.notifications,
        currentHostId: typeof p.currentHostId === 'string' ? p.currentHostId : null,
        hostNames: names,
      };
    } catch {
      return { ...DEFAULTS, hostNames: {} };
    }
  }

  /** Read-modify-write, one at a time, so two quick changes cannot lose each other. */
  #update(change: (s: Stored) => void): Promise<void> {
    const run = this.#queue.then(async () => {
      const s = await this.#read();
      change(s);
      await this.#store.setItemAsync(SETTINGS_KEY, JSON.stringify(s), this.#options);
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** "Require Face ID to allow"; on by default (spec §11.4). */
  async requireBiometric(): Promise<boolean> {
    return (await this.#read()).requireBiometric;
  }
  setRequireBiometric(on: boolean): Promise<void> {
    return this.#update((s) => void (s.requireBiometric = on));
  }

  async notificationsEnabled(): Promise<boolean> {
    return (await this.#read()).notifications;
  }
  setNotificationsEnabled(on: boolean): Promise<void> {
    return this.#update((s) => void (s.notifications = on));
  }

  async currentHostId(): Promise<string | null> {
    return (await this.#read()).currentHostId;
  }
  setCurrentHostId(hostId: string | null): Promise<void> {
    return this.#update((s) => void (s.currentHostId = hostId));
  }

  async hostNames(): Promise<Record<string, string>> {
    return (await this.#read()).hostNames;
  }
  /** Empty name — back to the name the Mac gave. */
  setHostName(hostId: string, name: string): Promise<void> {
    const clean = name.trim().slice(0, HOST_NAME_MAX);
    return this.#update((s) => {
      if (clean === '') delete s.hostNames[hostId];
      else s.hostNames[hostId] = clean;
    });
  }
  /** Forget everything stored for a removed Mac. */
  forgetHost(hostId: string): Promise<void> {
    return this.#update((s) => {
      delete s.hostNames[hostId];
      if (s.currentHostId === hostId) s.currentHostId = null;
    });
  }
}

export const displayName = (host: { hostId: string; hostName: string }, names: Record<string, string>): string =>
  names[host.hostId] ?? (host.hostName || 'Mac');
