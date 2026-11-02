import { afterEach, describe, expect, it, vi } from 'vitest';
import { MIN_CLIENT_VERSION, REMOTE_METHODS, type PhoneActionEvent } from '@parley/protocol/remote';
import { HostCallError, createSessionHandler, type HostLink, type HostLinkEvent, type PhoneSessions } from '@parley/remote';
import { createPhoneActionNotifier } from './phone-actions.js';

/** The real bridge dispatcher (schema on its side) → the real window notifier (schema on its side). */
const D = 'AAAAAAAAAAAAAAAAAAAAAA';
const ref = (sessionId: string) => ({ projectPath: '/Users/a/proj', workId: 'w-1', sessionId });
const enc = new TextEncoder();

function bridge(handler: (method: string, params: unknown) => unknown) {
  const events: PhoneActionEvent[] = [];
  const listeners = new Set<(e: HostLinkEvent) => void>();
  const host = {
    status: 'online',
    epoch: 'b:1',
    methods: [...REMOTE_METHODS],
    failure: null,
    snapshot: { revision: 1, branches: {}, entries: [] },
    activity: new Map(),
    start() {},
    async stop() {},
    call: async (method: string, params?: unknown) => handler(method, params),
    subscribe: (l: (e: HostLinkEvent) => void) => (listeners.add(l), () => listeners.delete(l)),
  } as unknown as HostLink;
  const sessions: PhoneSessions = { send: () => true, close() {}, bufferedBytes: () => 0, async setPush() {} };
  const dispatcher = createSessionHandler({
    host,
    sessions,
    audit: { append() {}, tail: () => [] },
    log: { info() {}, warn() {}, error() {}, addSecret() {} },
    info: { hostId: 'h1', hostName: 'Mac', bridgeVersion: '0.1.0', minClient: MIN_CLIENT_VERSION, relays: [] },
    deviceName: () => 'Phone 1',
    onPhoneAction: (event) => void events.push(event),
  });
  dispatcher.onOpen(D);
  let n = 0;
  const call = (method: string, params: unknown) => dispatcher.onFrame(D, enc.encode(JSON.stringify({ id: `m${++n}`, method, params })));
  return { call, events, emit: (event: string, data: unknown) => listeners.forEach((l) => l({ type: 'host', event, data } as HostLinkEvent)), stop: () => dispatcher.stop() };
}

describe('bridge phone.action → window notification text', () => {
  const stops: Array<() => void> = [];
  afterEach(() => stops.splice(0).forEach((stop) => stop()));

  it('every kind arrives as the expected text, with no ids and no agent texts', async () => {
    let trusted = false;
    const b = bridge((method, params) => {
      if (method === 'trust.check') return { trusted };
      if (method === 'sessions.create') {
        if ((params as { trustFolder?: boolean }).trustFolder === true) trusted = true;
        return { ref: ref('s-9') };
      }
      return { applied: true, state: 'allowed' };
    });
    stops.push(b.stop);
    b.emit('consents.changed', {
      upsert: [
        { id: 'c-12', kind: 'agent-switch', projectPath: '/p', ref: ref('s-1'), provider: 'codex', providerLabel: 'Codex', model: null, reason: 'SECRET', at: 'a', state: 'pending', requestedBy: { sessionId: 's-1', label: 'l' } },
      ],
      removed: [],
    });
    b.call('sessions.create', { projectPath: '/Users/a/proj', workId: 'w-1', provider: 'claude', label: 'L', task: 'SECRET TASK', parent: null, trustFolder: true });
    b.call('consents.decide', { id: 'c-12', decision: 'allow' });
    b.call('feed.decide', { ref: ref('s-1'), cardId: 'k', decision: { kind: 'permission', behavior: 'allow', always: true } });
    b.call('feed.decide', { ref: ref('s-1'), cardId: 'k2', decision: { kind: 'plan', choice: 'auto-accept' } });
    await vi.waitFor(() => expect(b.events).toHaveLength(5));

    const bodies: string[] = [];
    let t = 0;
    const notifier = createPhoneActionNotifier({
      create: (o) => {
        bodies.push(o.body);
        return { show() {}, close() {}, on() {} };
      },
      deviceName: async () => 'Anna iPhone',
      workTitle: async (r) => (r.workId === 'w-1' ? 'Auth rework' : null),
      focusWindow() {},
      confirmRevoke: async () => false,
      revoke: async () => undefined,
      now: () => (t += 20_000),
    });
    for (const event of b.events) notifier.handle(event);
    await vi.waitFor(() => expect(bodies).toHaveLength(5));
    expect([...bodies].sort()).toEqual(
      ['Allowed always: Auth rework', 'Approved a plan with auto-accept', 'Approved a switch to Codex', 'Started a session in Auth rework', 'Trusted folder proj'].sort(),
    );
    expect(bodies.join(' ')).not.toMatch(/c-12|SECRET/);
  });

  it('a launch that fails after the host wrote the trust still reports the trusted folder', async () => {
    let trusted = false;
    const b = bridge((method, params) => {
      if (method === 'trust.check') return { trusted };
      if ((params as { trustFolder?: boolean }).trustFolder === true) trusted = true;
      throw new HostCallError('conflict', 'launch failed');
    });
    stops.push(b.stop);
    b.call('sessions.create', { projectPath: '/Users/a/proj', workId: 'w-1', provider: 'claude', label: 'L', task: 't', parent: null, trustFolder: true });
    await vi.waitFor(() => expect(b.events).toEqual([{ deviceId: D, kind: 'trust-folder', target: '/Users/a/proj' }]));
  });
});
