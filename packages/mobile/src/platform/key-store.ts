// KeyStore on expo-secure-store (spec §7.8): one JSON record per host, plus an index of host ids because the
// Keychain API cannot enumerate keys. Accessible only after the first unlock and never migrated to another device.
import type { KeyStore } from '@parley/remote-client';
import type { HostRecord } from '@parley/remote-client';

/** The slice of `expo-secure-store` used here; the real module satisfies it. */
export interface SecureStoreLike {
  getItemAsync(key: string, options?: object): Promise<string | null>;
  setItemAsync(key: string, value: string, options?: object): Promise<void>;
  deleteItemAsync(key: string, options?: object): Promise<void>;
}

export const INDEX_KEY = 'parley.hosts';
const RECORD_PREFIX = 'parley.host.';
/** expo-secure-store keys: letters, digits, `.`, `-`, `_`. */
const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;

const recordKey = (hostId: string): string => {
  if (!SAFE_ID.test(hostId)) throw new Error('key store: unsupported host id');
  return RECORD_PREFIX + hostId;
};

export function createKeyStore(store: SecureStoreLike, options: object): KeyStore {
  const readIndex = async (): Promise<string[]> => {
    const raw = await store.getItemAsync(INDEX_KEY, options);
    if (raw === null) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  };
  const writeIndex = (ids: string[]): Promise<void> => store.setItemAsync(INDEX_KEY, JSON.stringify(ids), options);

  return {
    async list(): Promise<HostRecord[]> {
      const out: HostRecord[] = [];
      for (const id of await readIndex()) {
        const raw = await store.getItemAsync(recordKey(id), options);
        if (raw === null) continue;
        try {
          out.push(JSON.parse(raw) as HostRecord);
        } catch {
          // Unreadable record: still listed by id so `HostStore.wipeAll()` removes it; the schema check drops it elsewhere.
          out.push({ hostId: id } as HostRecord);
        }
      }
      return out;
    },
    async put(record: HostRecord): Promise<void> {
      await store.setItemAsync(recordKey(record.hostId), JSON.stringify(record), options);
      const ids = await readIndex();
      if (!ids.includes(record.hostId)) await writeIndex([...ids, record.hostId]);
    },
    async remove(hostId: string): Promise<void> {
      const ids = await readIndex();
      await writeIndex(ids.filter((id) => id !== hostId));
      await store.deleteItemAsync(recordKey(hostId), options);
    },
  };
}
