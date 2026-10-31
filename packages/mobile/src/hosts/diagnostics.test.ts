import { describe, expect, it } from 'vitest';
import type { HostRecord } from '@parley/remote-client';
import { diagnosticsRows } from './diagnostics';
import { hostStatusLine } from './status-line';

describe('diagnosticsRows', () => {
  it('shows dashes with no host and only 8 characters of the device id', () => {
    const empty = diagnosticsRows({ host: null, supervisor: null, hostStatus: null, rtt: null });
    expect(empty.every((r) => r.value === '—')).toBe(true);
    const host = { relay: 'r.example.com', deviceId: 'ABCDEFGHIJKLMNOPQRSTUV', lastTs: 0 } as HostRecord;
    const rows = diagnosticsRows({
      host,
      supervisor: { state: 'ready', relayError: null, blocked: null, hello: null, retryAt: null },
      hostStatus: 'online',
      rtt: 48,
    });
    expect(Object.fromEntries(rows.map((r) => [r.key, r.value]))).toMatchObject({
      Relay: 'r.example.com',
      State: 'ready',
      RTT: '48 ms',
      Host: 'online',
      'Device ID': 'ABCDEFGH',
    });
  });
});

describe('hostStatusLine', () => {
  it('reads like D1 §11', () => {
    const sup = (state: string) => ({ state, relayError: null, blocked: null, hello: null, retryAt: null }) as never;
    expect(hostStatusLine(sup('ready'), 'online', 48)).toBe('Connected · 48 ms');
    expect(hostStatusLine(sup('connecting'), null, null)).toBe('Connecting…');
    expect(hostStatusLine(null, null, null)).toBe('Not connected');
  });
});
