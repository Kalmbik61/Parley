// Critic m5 on A6 (relay device required for connect) and m4 / m5 on A3 (fail-closed channel, no compression of
// secrets).
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { FLAG_DEFLATE, FrameCodec, generateKeyPair, initiator, responder } from '@parley/noise';
import type { AuditLog } from './audit.js';
import type { DeviceStore } from './devices.js';
import type { BridgeKeys } from './keys.js';
import type { BridgeLog } from './log.js';
import { FailureLimiter, MAX_PENDING_ACCEPTS, NoiseChannel, SessionManager } from './sessions.js';

describe('SessionManager.handleIncoming', () => {
  it('ignores a connect stream without a relay-named device', async () => {
    let accepted = 0;
    const manager = new SessionManager({
      keys: () => ({}) as BridgeKeys,
      devices: {} as DeviceStore,
      link: {
        accept: () => {
          accepted += 1;
          throw new Error('must not accept');
        },
      },
      audit: { append: () => {}, tail: () => [] } as AuditLog,
      log: { info() {}, warn() {}, error() {}, addSecret() {} } as BridgeLog,
    });
    await manager.handleIncoming({ stream: 's1', kind: 'connect' });
    expect(accepted).toBe(0);
  });
});

// Critic m4 / m5 on A3: the transport wrapper fails closed, and secret-carrying frames go uncompressed.

function fakeSocket() {
  const sent: Uint8Array[] = [];
  const ws = {
    readyState: 1 as number,
    closedWith: null as number | null,
    send(data: Uint8Array, _opts: unknown, cb?: () => void) {
      sent.push(data);
      cb?.();
    },
    close(code: number) {
      this.closedWith = code;
      this.readyState = 3;
    },
  };
  return { ws, sent };
}

function pair() {
  const hs = generateKeyPair();
  const i = initiator({
    pattern: 'IK',
    prologue: new Uint8Array(0),
    s: generateKeyPair(),
    rs: hs.publicKey,
  });
  const r = responder({ pattern: 'IK', prologue: new Uint8Array(0), s: hs });
  r.readMessage(i.writeMessage());
  i.readMessage(r.writeMessage());
  return { phone: i.split(), bridge: r.split() };
}

describe('NoiseChannel', () => {
  it('fails closed on the first bad message: keys gone, socket closed, later calls refused', () => {
    const { phone, bridge } = pair();
    const { ws } = fakeSocket();
    const channel = new NoiseChannel(ws as unknown as WebSocket, bridge, 64 * 1024);
    const codec = new FrameCodec({ maxFrame: 1 << 20 });
    const good = phone.send.encryptWithAd(
      new Uint8Array(0),
      codec.encode(new TextEncoder().encode('{"a":1}'))[0]!,
    );
    const tampered = good.slice();
    tampered[tampered.length - 1]! ^= 1;
    expect(() => channel.receive(Buffer.from(tampered), true)).toThrow();
    expect(channel.failed).toBe(true);
    expect(ws.closedWith).toBe(1002);
    // The untouched message would decrypt with this nonce, but the channel stays dead.
    expect(() => channel.receive(Buffer.from(good), true)).toThrow('channel failed');
    expect(channel.send(new Uint8Array([1]))).toBe(false);
  });

  it('a text message is fatal too', () => {
    const { bridge } = pair();
    const { ws } = fakeSocket();
    const channel = new NoiseChannel(ws as unknown as WebSocket, bridge, 64 * 1024);
    expect(() => channel.receive(Buffer.from('{"t":"error"}'), false)).toThrow();
    expect(channel.failed).toBe(true);
  });

  it('compress: false keeps a compressible frame uncompressed on the wire', () => {
    const { phone, bridge } = pair();
    const { ws, sent } = fakeSocket();
    const channel = new NoiseChannel(ws as unknown as WebSocket, bridge, 64 * 1024);
    const frame = new TextEncoder().encode(
      JSON.stringify({ t: 'credentials', pad: 'x'.repeat(5000) }),
    );
    expect(channel.send(frame, { compress: false })).toBe(true);
    expect(channel.send(frame)).toBe(true);
    const flags = sent.map(
      (m) => phone.receive.decryptWithAd(new Uint8Array(0), m)[0]! & FLAG_DEFLATE,
    );
    expect(flags).toEqual([0, FLAG_DEFLATE]);
  });
});

// Critic m5 / m8 on A7: a relay cannot make the bridge hold unbounded streams or keys, nor flood the audit log.

describe('relay streams waiting for msg1', () => {
  it(`at most ${MAX_PENDING_ACCEPTS} accepted at once; the cap frees as streams end; one log line per saturation`, async () => {
    const streams: (EventEmitter & { terminate(): void })[] = [];
    const warnings: string[] = [];
    const manager = new SessionManager({
      keys: () => ({}) as BridgeKeys,
      devices: {} as DeviceStore,
      link: {
        accept: () => {
          const ws = Object.assign(new EventEmitter(), { terminate() {} });
          streams.push(ws);
          return ws as unknown as WebSocket;
        },
      },
      audit: { append: () => {}, tail: () => [] } as AuditLog,
      log: {
        info() {},
        warn: (e: string) => warnings.push(e),
        error() {},
        addSecret() {},
      } as BridgeLog,
      timing: { msg1Ms: 10_000 },
    });
    const runs = Array.from({ length: MAX_PENDING_ACCEPTS + 5 }, (_, i) =>
      manager.handleIncoming({ stream: `s${i}`, kind: 'connect', device: `d${i}` }),
    );
    expect(streams).toHaveLength(MAX_PENDING_ACCEPTS);
    expect(warnings).toEqual(['relay.incoming-capped']);
    for (const ws of streams.splice(0, 2)) ws.emit('close');
    await Promise.all(runs.slice(0, 2));
    void manager.handleIncoming({ stream: 'later', kind: 'connect', device: 'later' });
    expect(streams).toHaveLength(MAX_PENDING_ACCEPTS - 1);
    for (const ws of streams.splice(0)) ws.emit('close');
    await Promise.all(runs);
  });
});

describe('FailureLimiter', () => {
  it('a pause is announced once; idle keys are swept', () => {
    let t = 0;
    const limiter = new FailureLimiter(() => t, 2, 1000);
    for (let i = 0; i < 3; i++) limiter.fail('a');
    expect(limiter.check('a')).toEqual({ paused: true, first: true });
    expect(limiter.check('a')).toEqual({ paused: true, first: false });
    expect(limiter.check('b')).toEqual({ paused: false });
    // Many relay-chosen keys, then a quiet minute: one later failure sweeps them.
    for (let i = 0; i < 50; i++) limiter.fail(`k${i}`);
    expect(limiter.size).toBeGreaterThan(50);
    t += 61_000;
    expect(limiter.check('a')).toEqual({ paused: false });
    limiter.fail('z');
    expect(limiter.size).toBe(2); // 'z' and the global counter
    // A new pause after the old one ended is announced again.
    limiter.fail('z');
    limiter.fail('z');
    expect(limiter.check('z')).toEqual({ paused: true, first: true });
  });
});
