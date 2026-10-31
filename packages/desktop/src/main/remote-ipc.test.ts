import { describe, expect, it, vi } from 'vitest';
import type { RemoteEvent } from '../shared/remote-types.js';
import { createRemoteService } from './remote-ipc.js';
import type { ControlClient } from './remote-control.js';
import { ControlCallError } from './remote-control.js';
import type { RemoteLauncher } from './remote-launcher.js';

function setup(opts: { enabled?: boolean } = {}) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const listeners = new Set<(event: string, data: unknown) => void>();
  const closers = new Set<() => void>();
  let connected = false;
  const client: ControlClient = {
    connect: async () => void (connected = true),
    isConnected: () => connected,
    call: async (method, params) => {
      calls.push({ method, params });
      if (method === 'status') return { running: true, host: 'online', relay: 'connected', relayUrl: null, devices: 0, version: '1' };
      if (method === 'pair.start') return { qr: 'parley://pair?x', expiresAt: 123 };
      if (method === 'devices.list') return { devices: [] };
      if (method === 'audit.tail') return { records: [] };
      if (method === 'pair.answer') throw new ControlCallError('stale_request', 'stale_request');
      return { ok: true };
    },
    onEvent: (l) => (listeners.add(l), () => listeners.delete(l)),
    onClose: (l) => (closers.add(l), () => closers.delete(l)),
    close: () => void (connected = false),
  };
  const launcher: RemoteLauncher = {
    client,
    start: async () => void (connected = true),
    stop: async () => void (connected = false),
    detach: () => void (connected = false),
  };
  const events: RemoteEvent[] = [];
  let stored = opts.enabled ?? false;
  const service = createRemoteService({
    launcher,
    powerMonitor: { getSystemIdleState: () => 'active', on: () => undefined },
    loadEnabled: async () => stored,
    saveEnabled: async (value) => void (stored = value),
    broadcast: (event) => events.push(event),
    qrDataUrl: async (text) => `data:image/png;base64,${text}`,
  });
  return { service, calls, events, listeners, closers, stored: () => stored };
}

describe('remote service', () => {
  it('starts the bridge at launch while the switch was left on, and sends presence', async () => {
    const t = setup({ enabled: true });
    await t.service.init();
    expect((await t.service.call('state', {})).process).toBe('running');
    expect(t.calls.some((c) => c.method === 'presence' && JSON.stringify(c.params) === '{"state":"active"}')).toBe(true);
    t.service.dispose();
  });

  it('turns the switch on and off, persisting it', async () => {
    const t = setup();
    expect((await t.service.call('setEnabled', { enabled: true })).process).toBe('running');
    expect(t.stored()).toBe(true);
    expect((await t.service.call('setEnabled', { enabled: false })).process).toBe('off');
    expect(t.stored()).toBe(false);
  });

  it('passes pair events to the windows and turns the offer into an image in main', async () => {
    const t = setup();
    await t.service.call('setEnabled', { enabled: true });
    expect(await t.service.call('pair.start', {})).toEqual({ qr: 'data:image/png;base64,parley://pair?x', expiresAt: 123 });
    const request = { requestId: 'r1', name: 'Phone', platform: 'ios', sas: '123456', fingerprint: 'ab', expiresAt: 9 };
    for (const l of t.listeners) l('pair.request', request);
    for (const l of t.listeners) l('pair.offerClosed', { reason: 'bad-psk' });
    for (const l of t.listeners) l('something.else', {});
    expect(t.events.filter((e) => e.event !== 'state')).toEqual([
      { event: 'pair.request', data: request },
      { event: 'pair.offerClosed', data: { reason: 'bad-psk' } },
    ]);
  });

  it('sends pair.answer with the same requestId and keeps the refusal code', async () => {
    const t = setup();
    await t.service.call('setEnabled', { enabled: true });
    await expect(t.service.call('pair.answer', { requestId: 'req-A', allow: true })).rejects.toMatchObject({ code: 'stale_request' });
    expect(t.calls.find((c) => c.method === 'pair.answer')?.params).toEqual({ requestId: 'req-A', allow: true });
  });

  it('shows a stopped bridge as an error while the switch is on', async () => {
    const t = setup();
    await t.service.call('setEnabled', { enabled: true });
    for (const l of t.closers) l();
    const last = t.events.at(-1);
    expect(last).toMatchObject({ event: 'state', data: { process: 'error' } });
    vi.useRealTimers();
  });
});
