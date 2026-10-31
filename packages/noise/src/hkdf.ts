import { NoiseError } from './errors.js';
import { concat, utf8, wipe, EMPTY } from './bytes.js';
import { noblePrimitives, type NoisePrimitives } from './primitives.js';

/**
 * HKDF (RFC 5869) over the suite's HMAC — SHA-256 for the frozen suite. An empty salt means HASHLEN zero
 * bytes (RFC 5869 §2.2). Not the Noise HKDF of §4.3, which lives in `symmetric.ts`.
 */
export function hkdf(
  ikm: Uint8Array,
  info: Uint8Array | string,
  length: number,
  salt: Uint8Array = EMPTY,
  primitives: NoisePrimitives = noblePrimitives,
): Uint8Array {
  const hashLen = primitives.hashLen;
  if (!Number.isInteger(length) || length < 1 || length > 255 * hashLen) {
    throw new NoiseError('size', 'hkdf length out of range');
  }
  const infoBytes = typeof info === 'string' ? utf8(info) : info;
  const prk = primitives.hmac(salt.length ? salt : new Uint8Array(hashLen), ikm);
  const out = new Uint8Array(length);
  let t: Uint8Array = EMPTY;
  for (let i = 0, at = 0; at < length; i++) {
    const next = primitives.hmac(prk, concat(t, infoBytes, Uint8Array.of(i + 1)));
    wipe(t);
    t = next;
    out.set(t.subarray(0, Math.min(t.length, length - at)), at);
    at += t.length;
  }
  wipe(t);
  wipe(prk);
  return out;
}

export const PAIR_PSK_INFO = 'parley-pair-psk-v1';
export const PAIR_LOOKUP_INFO = 'parley-pair-lookup-v1';

/** Offer keys from the QR secret `s` (spec §7.3): the IKpsk0 psk and the relay lookup id. */
export function derivePairKeys(s: Uint8Array): { psk: Uint8Array; lookup: Uint8Array } {
  if (s.length !== 16) throw new NoiseError('key', 'pairing secret must be 16 bytes');
  return { psk: hkdf(s, PAIR_PSK_INFO, 32), lookup: hkdf(s, PAIR_LOOKUP_INFO, 16) };
}
