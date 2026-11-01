import { describe, expect, it, vi } from 'vitest';
import type { HostRecord } from '@parley/remote-client';
import { clearHostNotifications } from './clear';
import { registerPush } from './register';
import { resolvePushTarget } from './route';

const id16 = (c: string) => ({ a: 'A', b: 'Q', c: 'g' })[c as 'a']!.repeat(22);
const host = (hostId: string, routeId: string) => ({ hostId, routeId }) as unknown as HostRecord;
const hosts = [host('a', id16('a')), host('b', id16('b'))];
const data = (route: string) => ({ v: 1, kind: 'needs-you', count: 3, route });

describe('push route', () => {
  it('picks the host of two by data.route', () => {
    expect(resolvePushTarget(data(id16('b')), hosts)).toMatchObject({ kind: 'host', host: { hostId: 'b' }, count: 3 });
    expect(resolvePushTarget(data(id16('a')), hosts)).toMatchObject({ kind: 'host', host: { hostId: 'a' } });
  });
  it('unknown route or junk data → host list', () => {
    expect(resolvePushTarget(data(id16('c')), hosts)).toEqual({ kind: 'unknown' });
    expect(resolvePushTarget({ nope: 1 }, hosts)).toEqual({ kind: 'unknown' });
    expect(resolvePushTarget(undefined, hosts)).toEqual({ kind: 'unknown' });
  });
});

describe('registerPush', () => {
  const token = 'ab'.repeat(32);
  it('sends the token inside Noise', async () => {
    const call = vi.fn(async () => ({}));
    expect(await registerPush({ getToken: async () => ({ data: token }), call, env: 'sandbox' })).toBe('registered');
    expect(call).toHaveBeenCalledWith('push.register', { apnsToken: token, env: 'sandbox' });
  });
  it('a token error does not block: registers null and never throws', async () => {
    const call = vi.fn(async () => ({}));
    const seen: string[] = [];
    const a = await registerPush({ getToken: async () => { throw new Error('no entitlement'); }, call, env: 'production', onAvailability: (x) => seen.push(x) });
    expect(a).toBe('unavailable');
    expect(call).toHaveBeenCalledWith('push.register', { apnsToken: null, env: 'production' });
    expect(seen).toEqual(['unavailable']);
  });
  it('a malformed token is treated as none; a failed call does not throw', async () => {
    const call = vi.fn(async () => { throw new Error('lost'); });
    expect(await registerPush({ getToken: async () => ({ data: 'zz' }), call, env: 'sandbox' })).toBe('unavailable');
    expect(call).toHaveBeenCalledWith('push.register', { apnsToken: null, env: 'sandbox' });
  });
});

describe('clearHostNotifications', () => {
  it('dismisses only the opened host’s notifications and sets the badge', async () => {
    const dismiss = vi.fn(async () => undefined);
    const badge = vi.fn(async () => true);
    await clearHostNotifications(
      {
        getPresentedNotificationsAsync: async () => [
          { request: { identifier: 'n1', content: { data: data(id16('a')) } } },
          { request: { identifier: 'n2', content: { data: data(id16('b')) } } },
        ],
        dismissNotificationAsync: dismiss,
        setBadgeCountAsync: badge,
      },
      hosts[0]!,
      2,
    );
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(dismiss).toHaveBeenCalledWith('n1');
    expect(badge).toHaveBeenCalledWith(2);
  });
});
