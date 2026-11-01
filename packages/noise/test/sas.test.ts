import { hkdfSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  derivePairKeys,
  hkdf,
  initiator,
  noblePrimitives,
  responder,
  sas,
  type HandshakeState,
} from '../src/index.js';
import { hex, keyPair, seeded, toHex, withEphemeral } from './helpers.js';

const prologue = new TextEncoder().encode('parley-pair/1');

describe('hkdf (RFC 5869, SHA-256)', () => {
  it('RFC 5869 test case 1', () => {
    const okm = hkdf(
      hex('0b'.repeat(22)),
      hex('f0f1f2f3f4f5f6f7f8f9'),
      42,
      hex('000102030405060708090a0b0c'),
    );
    expect(toHex(okm)).toBe(
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
    );
  });

  it('RFC 5869 test case 3 (empty salt and info)', () => {
    expect(toHex(hkdf(hex('0b'.repeat(22)), '', 42))).toBe(
      '8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8',
    );
  });

  it('matches node:crypto hkdfSync for many lengths', () => {
    for (const length of [1, 4, 16, 31, 32, 33, 64, 100, 255 * 32]) {
      const ikm = seeded(`ikm${length}`, 1 + (length % 50));
      const salt = seeded(`salt${length}`, length % 3 === 0 ? 0 : 13);
      const ours = hkdf(ikm, `info-${length}`, length, salt);
      const theirs = new Uint8Array(hkdfSync('sha256', ikm, salt, `info-${length}`, length));
      expect(toHex(ours)).toBe(toHex(theirs));
    }
    expect(() => hkdf(seeded('a'), '', 255 * 32 + 1)).toThrow();
    expect(() => hkdf(seeded('a'), '', 0)).toThrow();
  });

  it('derivePairKeys: psk and lookup from s (spec §7.3)', () => {
    const s = seeded('qr secret', 16);
    const { psk, lookup } = derivePairKeys(s);
    expect(psk).toHaveLength(32);
    expect(lookup).toHaveLength(16);
    const node = (info: string, n: number) =>
      toHex(new Uint8Array(hkdfSync('sha256', s, new Uint8Array(0), info, n)));
    expect(toHex(psk)).toBe(node('parley-pair-psk-v1', 32));
    expect(toHex(lookup)).toBe(node('parley-pair-lookup-v1', 16));
    expect(() => derivePairKeys(new Uint8Array(32))).toThrow();
  });
});

describe('SAS (spec §7.4)', () => {
  it('is uint32_be(HKDF(h, "parley-sas-v1", 4)) mod 10^6, six digits', () => {
    for (let n = 0; n < 50; n++) {
      const h = seeded(`h${n}`);
      const okm = Buffer.from(hkdfSync('sha256', h, new Uint8Array(0), 'parley-sas-v1', 4));
      const expected = String(okm.readUInt32BE(0) % 1_000_000).padStart(6, '0');
      expect(sas(h)).toBe(expected);
      expect(sas(h)).toMatch(/^\d{6}$/);
    }
    expect(() => sas(new Uint8Array(31))).toThrow();
  });

  // One deterministic msg1 with one psk, read by two independent responders with different `e`.
  const hs = keyPair(seeded('HS'));
  const ds = keyPair(seeded('DS_h'));
  const { psk } = derivePairKeys(seeded('s', 16));
  const payload = new TextEncoder().encode(
    '{"v":1,"name":"iPhone","platform":"ios","app":"1.0.0"}',
  );
  const phone = (): HandshakeState =>
    initiator({
      pattern: 'IKpsk0',
      prologue,
      s: ds,
      rs: hs.publicKey,
      psk,
      primitives: withEphemeral(noblePrimitives, seeded('phone e')),
    });
  const mac = (label: string): HandshakeState =>
    responder({
      pattern: 'IKpsk0',
      prologue,
      s: hs,
      psk,
      primitives: withEphemeral(noblePrimitives, seeded(label)),
    });

  it('the msg1 fixture is deterministic', () => {
    expect(toHex(phone().writeMessage(payload))).toBe(toHex(phone().writeMessage(payload)));
  });

  it('two responders with different e give different SAS for the same msg1', () => {
    const msg1 = phone().writeMessage(payload);
    const results = ['mac e 1', 'mac e 2'].map((label) => {
      const r = mac(label);
      expect(r.readMessage(msg1)).toEqual(payload);
      const msg2 = r.writeMessage(new TextEncoder().encode('{"v":1}'));
      return { msg2, code: sas(r.handshakeHash()) };
    });
    expect(results[0]!.code).not.toBe(results[1]!.code);

    // Initiator and responder of one handshake agree, for each of the two answers.
    for (const { msg2, code } of results) {
      const i = phone();
      i.writeMessage(payload);
      i.readMessage(msg2);
      expect(sas(i.handshakeHash())).toBe(code);
    }
  });

  it('SAS needs the finished handshake', () => {
    const i = phone();
    i.writeMessage(payload);
    expect(() => i.handshakeHash()).toThrow('handshake not complete');
  });
});
