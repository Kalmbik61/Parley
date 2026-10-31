import { describe, expect, it } from 'vitest';
import type { SupervisorStatus } from '@parley/remote-client';
import { bannerFor, blockedScreen, type BannerInput } from './banner-model';

const sup = (patch: Partial<SupervisorStatus>): SupervisorStatus => ({
  state: 'ready',
  relayError: null,
  blocked: null,
  hello: null,
  retryAt: null,
  ...patch,
});
const input = (patch: Partial<BannerInput>): BannerInput => ({
  supervisor: sup({}),
  hostStatus: 'online',
  hasSnapshot: true,
  lastUpdatedAt: 1_000,
  waitingSince: null,
  relay: 'relay.example.com',
  now: 121_000,
  ...patch,
});
const kind = (patch: Partial<BannerInput>) => bannerFor(input(patch))?.kind ?? null;

describe('bannerFor (D1 §4)', () => {
  it('shows nothing for a ready connection to an online host, and without a host', () => {
    expect(kind({})).toBeNull();
    expect(kind({ supervisor: null })).toBeNull();
  });

  it('cold start vs reconnect', () => {
    expect(kind({ supervisor: sup({ state: 'connecting' }), hasSnapshot: false, lastUpdatedAt: null })).toBe('connecting');
    const b = bannerFor(input({ supervisor: sup({ state: 'handshaking' }) }))!;
    expect(b).toMatchObject({ kind: 'updating', detail: 'Last updated 2 min ago', delayMs: 1500 });
  });

  it('long wait: relay unreachable with a countdown and Retry', () => {
    const b = bannerFor(input({ supervisor: sup({ state: 'waiting', retryAt: 133_000 }), waitingSince: 60_000 }))!;
    expect(b).toMatchObject({ kind: 'relay-unreachable', detail: 'relay.example.com · Retrying in 12 s', actions: ['retry'] });
    expect(kind({ supervisor: sup({ state: 'waiting' }), waitingSince: 100_000 })).toBe('updating');
    // the relay answered (rate_limited): reachable, so a long neutral back-off, not an outage
    const slow = bannerFor(
      input({ supervisor: sup({ state: 'waiting', relayError: 'rate_limited', retryAt: 133_000 }), waitingSince: 60_000 }),
    )!;
    expect(slow).toMatchObject({ kind: 'retrying', tone: 'neutral', text: 'Updating…', detail: 'Retrying in 12 s', actions: ['retry'] });
  });

  it('offline, relay errors, host status', () => {
    expect(kind({ supervisor: sup({ state: 'offline' }) })).toBe('no-internet');
    expect(kind({ supervisor: sup({ state: 'waiting', relayError: 'host_offline' }) })).toBe('mac-offline');
    const nr = bannerFor(input({ supervisor: sup({ state: 'waiting', relayError: 'unknown_route' }) }))!;
    expect(nr).toMatchObject({ kind: 'not-recognized', actions: ['pair-again', 'remove'] });
    expect(kind({ hostStatus: 'starting' })).toBe('mac-starting');
    expect(kind({ hostStatus: 'offline' })).toBe('host-not-running');
  });

  it('blocked states and an incompatible host are full screens, not banners', () => {
    expect(kind({ supervisor: sup({ state: 'blocked', blocked: 'revoked' }) })).toBeNull();
    expect(blockedScreen('revoked', null)).toBe('revoked');
    expect(blockedScreen('reset', null)).toBe('revoked');
    expect(blockedScreen('update_phone', null)).toBe('update-phone');
    expect(blockedScreen(null, 'incompatible')).toBe('update-mac');
    expect(kind({ hostStatus: 'incompatible' })).toBeNull();
    expect(blockedScreen(null, 'online')).toBeNull();
  });
});
