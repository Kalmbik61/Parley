// APNs token → `push.register` inside Noise (spec §9.1): after every `ready` and on a token change. A token error
// never blocks connecting: the phone then registers `apnsToken: null` (Personal Team has no Push entitlement).
export type PushEnv = 'sandbox' | 'production';

export type PushAvailability = 'unknown' | 'registered' | 'unavailable';

export interface PushRegisterDeps {
  /** `Notifications.getDevicePushTokenAsync()`: `data` is the hex token on iOS. */
  getToken(): Promise<{ data: unknown }>;
  call(method: string, params: unknown): Promise<unknown>;
  env: PushEnv;
  onAvailability?(a: PushAvailability): void;
}

const HEX = /^[0-9a-fA-F]{32,200}$/;

/** Never throws. Returns what was registered. */
export async function registerPush(deps: PushRegisterDeps): Promise<PushAvailability> {
  let token: string | null = null;
  try {
    const { data } = await deps.getToken();
    token = typeof data === 'string' && HEX.test(data) ? data : null;
  } catch {
    token = null;
  }
  const availability: PushAvailability = token === null ? 'unavailable' : 'registered';
  try {
    await deps.call('push.register', { apnsToken: token, env: deps.env });
  } catch {
    // The bridge will hear it on the next `ready`.
  }
  deps.onAvailability?.(availability);
  return availability;
}
