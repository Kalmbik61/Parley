import { describe, expect, it } from 'vitest';
import { EMPTY } from '../src/bytes.js';
import {
  CipherState,
  CLOSE_NONCE,
  MAX_NONCE,
  NoiseError,
  generateKeyPair,
  initiator,
  noblePrimitives,
  responder,
  type HandshakeState,
  type KeyPair,
  type PatternName,
} from '../src/index.js';
import { seeded } from './helpers.js';

const prologue = new TextEncoder().encode('parley-pair/1');

function pair(
  pattern: PatternName,
  over: { iPsk?: Uint8Array; rPsk?: Uint8Array; rs?: Uint8Array; hs?: KeyPair } = {},
) {
  const hs = over.hs ?? generateKeyPair();
  const ds = generateKeyPair();
  const psk = seeded('psk');
  const withPsk = (p?: Uint8Array) => (pattern === 'IKpsk0' ? { psk: p ?? psk } : {});
  const i = initiator({
    pattern,
    prologue,
    s: ds,
    rs: over.rs ?? hs.publicKey,
    ...withPsk(over.iPsk),
  });
  const r = responder({ pattern, prologue, s: hs, ...withPsk(over.rPsk) });
  return { i, r, hs, ds };
}

function complete(i: HandshakeState, r: HandshakeState) {
  r.readMessage(i.writeMessage(new Uint8Array([1, 2, 3])));
  i.readMessage(r.writeMessage(new Uint8Array([4, 5])));
  return { ic: i.split(), rc: r.split() };
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(NoiseError);
    return (error as NoiseError).code;
  }
  throw new Error('expected a NoiseError');
}

const flipLast = (m: Uint8Array): Uint8Array => {
  const out = m.slice();
  out[out.length - 1]! ^= 0x01;
  return out;
};

describe('handshake: tampering and wrong keys', () => {
  for (const pattern of ['IK', 'IKpsk0'] as const) {
    it(`${pattern}: foreign tag on msg1 and msg2 → decrypt error, state failed`, () => {
      const a = pair(pattern);
      expect(code(() => a.r.readMessage(flipLast(a.i.writeMessage(EMPTY))))).toBe('decrypt');
      expect(code(() => a.r.writeMessage(EMPTY))).toBe('state');

      const b = pair(pattern);
      b.r.readMessage(b.i.writeMessage(EMPTY));
      expect(code(() => b.i.readMessage(flipLast(b.r.writeMessage(EMPTY))))).toBe('decrypt');
      expect(code(() => b.i.handshakeHash())).toBe('state');
      expect(code(() => b.i.split())).toBe('state');
    });

    it(`${pattern}: initiator aimed at another responder key → responder cannot read s`, () => {
      const other = generateKeyPair();
      const { i, r } = pair(pattern, { rs: other.publicKey });
      expect(() => r.readMessage(i.writeMessage(EMPTY))).toThrow(
        'cannot decrypt the remote static key',
      );
    });

    it(`${pattern}: impostor msg2 from a responder without HS_priv → initiator fails`, () => {
      const real = pair(pattern);
      const msg1 = real.i.writeMessage(EMPTY);
      // The impostor runs its own handshake with its own key and replays its msg2 into the real one.
      const fake = pair(pattern);
      fake.r.readMessage(fake.i.writeMessage(EMPTY));
      expect(code(() => real.i.readMessage(fake.r.writeMessage(EMPTY)))).toBe('decrypt');
      // And the real responder still answers correctly.
      real.r.readMessage(msg1);
      expect(real.r.isMyTurn).toBe(true);
    });

    it(`${pattern}: truncated and oversized handshake messages are rejected`, () => {
      const a = pair(pattern);
      const m = a.i.writeMessage(EMPTY);
      expect(code(() => a.r.readMessage(m.subarray(0, 40)))).toBe('size');
      const b = pair(pattern);
      b.i.writeMessage(EMPTY);
      expect(code(() => b.r.readMessage(new Uint8Array(65_536)))).toBe('size');
      expect(code(() => pair(pattern).i.writeMessage(new Uint8Array(65_535)))).toBe('size');
    });
  }

  it('IKpsk0: wrong psk → error reading s in msg1', () => {
    const { i, r } = pair('IKpsk0', { rPsk: seeded('another psk') });
    expect(() => r.readMessage(i.writeMessage(new TextEncoder().encode('{"v":1}')))).toThrow(
      'cannot decrypt the remote static key',
    );
  });

  it('responder pinned to an expected initiator key rejects another one', () => {
    const hs = generateKeyPair();
    const expected = generateKeyPair();
    const i = initiator({ pattern: 'IK', prologue, s: generateKeyPair(), rs: hs.publicKey });
    const r = responder({ pattern: 'IK', prologue, s: hs, rs: expected.publicKey });
    expect(code(() => r.readMessage(i.writeMessage(EMPTY)))).toBe('key');
  });

  it('different prologues → msg1 fails', () => {
    const hs = generateKeyPair();
    const i = initiator({ pattern: 'IK', prologue, s: generateKeyPair(), rs: hs.publicKey });
    const r = responder({ pattern: 'IK', prologue: new Uint8Array([1]), s: hs });
    expect(code(() => r.readMessage(i.writeMessage(EMPTY)))).toBe('decrypt');
  });

  it('low-order remote ephemeral is rejected', () => {
    const { i, r } = pair('IK');
    const m = i.writeMessage(EMPTY).slice();
    m.fill(0, 0, 32);
    expect(code(() => r.readMessage(m))).toBe('key');
  });

  it('options are validated', () => {
    const hs = generateKeyPair();
    const s = generateKeyPair();
    expect(code(() => initiator({ pattern: 'IK', prologue, s }))).toBe('key');
    expect(code(() => initiator({ pattern: 'IKpsk0', prologue, s, rs: hs.publicKey }))).toBe('key');
    expect(
      code(() =>
        initiator({ pattern: 'IKpsk0', prologue, s, rs: hs.publicKey, psk: new Uint8Array(31) }),
      ),
    ).toBe('key');
    expect(
      code(() =>
        initiator({ pattern: 'IK', prologue, s, rs: hs.publicKey, psk: new Uint8Array(32) }),
      ),
    ).toBe('key');
    expect(code(() => initiator({ pattern: 'IK', prologue, s, rs: new Uint8Array(31) }))).toBe(
      'key',
    );
    expect(
      code(() => initiator({ pattern: 'XX' as PatternName, prologue, s, rs: hs.publicKey })),
    ).toBe('state');
    expect(
      code(() =>
        initiator({ pattern: 'constructor' as PatternName, prologue, s, rs: hs.publicKey }),
      ),
    ).toBe('state');
    expect(code(() => responder({ pattern: 'toString' as PatternName, prologue, s }))).toBe(
      'state',
    );
  });

  it('turn order is enforced', () => {
    const { i, r } = pair('IK');
    expect(code(() => r.writeMessage(EMPTY))).toBe('state');
    expect(code(() => i.readMessage(new Uint8Array(48)))).toBe('state');
    const msg1 = i.writeMessage(EMPTY);
    expect(code(() => i.writeMessage(EMPTY))).toBe('state');
    r.readMessage(msg1);
    i.readMessage(r.writeMessage(EMPTY));
    expect(code(() => i.writeMessage(EMPTY))).toBe('state');
    i.split();
    expect(code(() => i.split())).toBe('state');
    expect(i.handshakeHash()).toHaveLength(32);
  });
});

describe('transport: truncated, reordered, replayed', () => {
  for (const pattern of ['IK', 'IKpsk0'] as const) {
    it(`${pattern}: in-order messages pass both ways`, () => {
      const { i, r } = pair(pattern);
      const { ic, rc } = complete(i, r);
      for (let n = 0; n < 5; n++) {
        expect(
          rc.receive.decryptWithAd(EMPTY, ic.send.encryptWithAd(EMPTY, new Uint8Array([n]))),
        ).toEqual(new Uint8Array([n]));
        expect(
          ic.receive.decryptWithAd(EMPTY, rc.send.encryptWithAd(EMPTY, new Uint8Array([n, n]))),
        ).toEqual(new Uint8Array([n, n]));
      }
    });

    it(`${pattern}: truncated frame → error`, () => {
      const { i, r } = pair(pattern);
      const { ic, rc } = complete(i, r);
      const m = ic.send.encryptWithAd(EMPTY, new Uint8Array(100));
      expect(code(() => rc.receive.decryptWithAd(EMPTY, m.subarray(0, m.length - 1)))).toBe(
        'decrypt',
      );
      expect(code(() => rc.receive.decryptWithAd(EMPTY, m.subarray(0, 15)))).toBe('decrypt');
    });

    it(`${pattern}: foreign tag → error`, () => {
      const { i, r } = pair(pattern);
      const { ic, rc } = complete(i, r);
      expect(
        code(() =>
          rc.receive.decryptWithAd(
            EMPTY,
            flipLast(ic.send.encryptWithAd(EMPTY, new Uint8Array(10))),
          ),
        ),
      ).toBe('decrypt');
    });

    it(`${pattern}: reordered frames → error`, () => {
      const { i, r } = pair(pattern);
      const { ic, rc } = complete(i, r);
      const m0 = ic.send.encryptWithAd(EMPTY, new Uint8Array([0]));
      const m1 = ic.send.encryptWithAd(EMPTY, new Uint8Array([1]));
      expect(code(() => rc.receive.decryptWithAd(EMPTY, m1))).toBe('decrypt');
      // The failed message did not advance the nonce: m0 is still the expected one, and m1 only after it.
      expect(rc.receive.nonce).toBe(0n);
      expect(rc.receive.decryptWithAd(EMPTY, m0)).toEqual(new Uint8Array([0]));
      expect(rc.receive.decryptWithAd(EMPTY, m1)).toEqual(new Uint8Array([1]));
    });

    it(`${pattern}: replayed frame → error`, () => {
      const { i, r } = pair(pattern);
      const { ic, rc } = complete(i, r);
      const m0 = ic.send.encryptWithAd(EMPTY, new Uint8Array([0]));
      rc.receive.decryptWithAd(EMPTY, m0);
      expect(code(() => rc.receive.decryptWithAd(EMPTY, m0))).toBe('decrypt');
    });

    it(`${pattern}: a frame of one direction does not open in the other`, () => {
      const { i, r } = pair(pattern);
      const { ic } = complete(i, r);
      const m = ic.send.encryptWithAd(EMPTY, new Uint8Array([9]));
      expect(code(() => ic.receive.decryptWithAd(EMPTY, m))).toBe('decrypt');
    });
  }
});

describe('nonce limits', () => {
  const key = seeded('key');

  it('refuses 2^64−1 for encryption and decryption', () => {
    const c = new CipherState(noblePrimitives, key);
    c.setNonce(MAX_NONCE - 1n);
    const last = c.encryptWithAd(EMPTY, new Uint8Array([1]));
    expect(c.nonce).toBe(MAX_NONCE);
    expect(code(() => c.encryptWithAd(EMPTY, new Uint8Array([1])))).toBe('nonce');

    const d = new CipherState(noblePrimitives, key);
    d.setNonce(MAX_NONCE - 1n);
    expect(d.decryptWithAd(EMPTY, last)).toEqual(new Uint8Array([1]));
    expect(code(() => d.decryptWithAd(EMPTY, last))).toBe('nonce');
    expect(code(() => d.setNonce(MAX_NONCE + 1n))).toBe('nonce');
  });

  it('signals time to close at 2^32', () => {
    const c = new CipherState(noblePrimitives, key);
    c.setNonce(CLOSE_NONCE - 1n);
    expect(c.shouldClose).toBe(false);
    c.encryptWithAd(EMPTY, EMPTY);
    expect(c.shouldClose).toBe(true);
    expect(CLOSE_NONCE).toBe(2n ** 32n);
  });

  it('nonce encoding crosses the 32-bit boundary', () => {
    const a = new CipherState(noblePrimitives, key);
    const b = new CipherState(noblePrimitives, key);
    a.setNonce(CLOSE_NONCE);
    b.setNonce(0n);
    expect(a.encryptWithAd(EMPTY, EMPTY)).not.toEqual(b.encryptWithAd(EMPTY, EMPTY));
  });

  it('a destroyed cipher throws instead of passing plaintext through', () => {
    const c = new CipherState(noblePrimitives, key);
    c.destroy();
    expect(code(() => c.encryptWithAd(EMPTY, new Uint8Array([1])))).toBe('state');
    expect(code(() => c.decryptWithAd(EMPTY, new Uint8Array(17)))).toBe('state');
  });
});

describe('inputs are never written to', () => {
  it('handshake and transport leave caller buffers intact', () => {
    const hs = generateKeyPair();
    const ds = generateKeyPair();
    const psk = seeded('psk');
    const p1 = seeded('p1', 50);
    const p2 = seeded('p2', 70);
    const keep = [hs.privateKey, hs.publicKey, ds.privateKey, ds.publicKey, psk, p1, p2, prologue];
    const before = keep.map((b) => b.slice());

    const i = initiator({ pattern: 'IKpsk0', prologue, s: ds, rs: hs.publicKey, psk });
    const r = responder({ pattern: 'IKpsk0', prologue, s: hs, psk });
    const msg1 = i.writeMessage(p1);
    const msg1Copy = msg1.slice();
    expect(r.readMessage(msg1)).toEqual(p1);
    expect(msg1).toEqual(msg1Copy);
    const msg2 = r.writeMessage(p2);
    const msg2Copy = msg2.slice();
    expect(i.readMessage(msg2)).toEqual(p2);
    expect(msg2).toEqual(msg2Copy);
    const { send } = i.split();
    const { receive } = r.split();
    const pt = seeded('pt', 300);
    const ptCopy = pt.slice();
    const ct = send.encryptWithAd(EMPTY, pt);
    const ctCopy = ct.slice();
    expect(receive.decryptWithAd(EMPTY, ct)).toEqual(pt);
    expect(pt).toEqual(ptCopy);
    expect(ct).toEqual(ctCopy);
    keep.forEach((b, n) => expect(b).toEqual(before[n]));
  });

  it('returned keys and hashes are copies', () => {
    const { i, r } = pair('IK');
    complete(i, r);
    const h = i.handshakeHash();
    h.fill(0);
    expect(i.handshakeHash()).not.toEqual(h);
    const rs = r.remoteStatic()!;
    rs.fill(0);
    expect(r.remoteStatic()).not.toEqual(rs);
  });
});
