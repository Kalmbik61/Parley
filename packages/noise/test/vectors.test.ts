import { describe, expect, it } from 'vitest';
import { EMPTY } from '../src/bytes.js';
import {
  initiator,
  noblePrimitives,
  responder,
  type NoisePrimitives,
  type PatternName,
} from '../src/index.js';
import {
  blake2bPrimitives,
  hex,
  keyPair,
  loadVectors,
  toHex,
  withEphemeral,
  type Vector,
} from './helpers.js';

const IKPSK0_SHA = '5511d881fbb1a9bb550ef1cfde138bfd4bfbea1b2d38c6fe98c6201831f8bf79';
const CACOPHONY_SHA = '25b9e447febbaa5b09ab4f7d4485ab08c1080088b77b7ac77f1be0bc0edf3379';
const SNOW_SHA = '1d577cee3be3d6b8f1ec471045d32bb9f020428e0a7468eda8fd3283f806386f';

/** Plays a vector through both sides of the state machine and checks every byte. */
function play(v: Vector, primitives: NoisePrimitives): void {
  const pattern = v.protocol_name.split('_')[1] as PatternName;
  const ipsk = v.init_psks?.[0];
  const rpsk = v.resp_psks?.[0];
  const i = initiator({
    pattern,
    prologue: hex(v.init_prologue),
    s: keyPair(hex(v.init_static!), primitives),
    rs: hex(v.init_remote_static!),
    ...(ipsk ? { psk: hex(ipsk) } : {}),
    primitives: withEphemeral(primitives, hex(v.init_ephemeral)),
  });
  const r = responder({
    pattern,
    prologue: hex(v.resp_prologue),
    s: keyPair(hex(v.resp_static!), primitives),
    ...(rpsk ? { psk: hex(rpsk) } : {}),
    primitives: withEphemeral(primitives, hex(v.resp_ephemeral)),
  });

  const [m1, m2, ...transport] = v.messages;
  expect(toHex(i.writeMessage(hex(m1!.payload)))).toBe(m1!.ciphertext);
  expect(toHex(r.readMessage(hex(m1!.ciphertext)))).toBe(m1!.payload);
  expect(toHex(r.writeMessage(hex(m2!.payload)))).toBe(m2!.ciphertext);
  expect(toHex(i.readMessage(hex(m2!.ciphertext)))).toBe(m2!.payload);
  expect(i.isComplete && r.isComplete).toBe(true);
  expect(toHex(i.handshakeHash())).toBe(toHex(r.handshakeHash()));
  if (v.handshake_hash) expect(toHex(i.handshakeHash())).toBe(v.handshake_hash);
  expect(toHex(r.remoteStatic()!)).toBe(toHex(primitives.publicKey(hex(v.init_static!))));

  const ic = i.split();
  const rc = r.split();
  transport.forEach((m, n) => {
    const [from, to] = n % 2 === 0 ? [ic, rc] : [rc, ic];
    expect(toHex(from.send.encryptWithAd(EMPTY, hex(m.payload)))).toBe(m.ciphertext);
    expect(toHex(to.receive.decryptWithAd(EMPTY, hex(m.ciphertext)))).toBe(m.payload);
  });
}

describe('IKpsk0 vectors (flynn/noise × noiseprotocol)', () => {
  const vectors = loadVectors('ikpsk0-vectors.json', IKPSK0_SHA);

  it('has 3 vectors of the frozen suite and 3 of BLAKE2b', () => {
    expect(vectors.map((v) => v.protocol_name)).toEqual([
      ...Array(3).fill('Noise_IKpsk0_25519_ChaChaPoly_SHA256'),
      ...Array(3).fill('Noise_IKpsk0_25519_ChaChaPoly_BLAKE2b'),
    ]);
  });

  vectors.slice(0, 3).forEach((v, n) => {
    it(`vector ${n}: ${v.protocol_name}, handshake and 6 transport messages`, () => {
      expect(v.messages).toHaveLength(8);
      play(v, noblePrimitives);
    });
  });

  // Hash guard: BLAKE2b vectors pass only with BLAKE2b, and the frozen-suite primitives fail them.
  vectors.slice(3).forEach((v, n) => {
    it(`vector ${n + 3}: ${v.protocol_name} passes with BLAKE2b only`, () => {
      play(v, blake2bPrimitives);
      expect(() => play(v, noblePrimitives)).toThrow();
    });
  });

  it('frozen-suite vectors fail with the BLAKE2b hash', () => {
    expect(() => play(vectors[0]!, blake2bPrimitives)).toThrow();
  });
});

describe('IK vectors', () => {
  it('cacophony Noise_IK_25519_ChaChaPoly_SHA256: handshake, hash and 4 transport messages', () => {
    const vectors = loadVectors('cacophony-IK_25519_ChaChaPoly_SHA256.json', CACOPHONY_SHA);
    expect(vectors).toHaveLength(1);
    expect(vectors[0]!.messages).toHaveLength(6);
    expect(vectors[0]!.handshake_hash).toBeDefined();
    play(vectors[0]!, noblePrimitives);
  });

  it('snow Noise_IK_25519_ChaChaPoly_SHA256: handshake and 2 transport messages', () => {
    const vectors = loadVectors('snow-IK_25519_ChaChaPoly_SHA256.json', SNOW_SHA);
    expect(vectors).toHaveLength(1);
    expect(vectors[0]!.messages).toHaveLength(4);
    play(vectors[0]!, noblePrimitives);
  });
});
