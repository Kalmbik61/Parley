// "Require Face ID to allow" (D1 §11.6): local to the app, on by default, stored in the Keychain.
// A14's Settings screen renders the toggle; the gate and the screen both read it from here.
export const REQUIRE_FACE_ID_KEY = 'parley.requireFaceId';

export interface SettingStorage {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
}

export interface FaceIdSetting {
  /** Anything but an explicit "off" counts as on, including a read error: the safe side. */
  get(): Promise<boolean>;
  set(on: boolean): Promise<void>;
  subscribe(listener: (on: boolean) => void): () => void;
}

export function createFaceIdSetting(storage: SettingStorage): FaceIdSetting {
  const listeners = new Set<(on: boolean) => void>();
  return {
    async get() {
      try {
        return (await storage.getItemAsync(REQUIRE_FACE_ID_KEY)) !== 'off';
      } catch {
        return true;
      }
    },
    async set(on) {
      await storage.setItemAsync(REQUIRE_FACE_ID_KEY, on ? 'on' : 'off');
      for (const l of [...listeners]) l(on);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/**
 * Settings toggle flow: turning off asks Face ID itself, turning on is immediate. Returns the value now stored.
 */
export async function toggleFaceId(
  setting: FaceIdSetting,
  approve: (kind: 'disable') => Promise<'ok' | 'cancelled'>,
  next: boolean,
): Promise<boolean> {
  if (!next && (await approve('disable')) !== 'ok') return true;
  await setting.set(next);
  return next;
}
