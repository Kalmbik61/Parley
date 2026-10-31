import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hmac } from '@noble/hashes/hmac.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { noblePrimitives, type KeyPair, type NoisePrimitives } from '../src/index.js';

export const here = dirname(fileURLToPath(import.meta.url));

export const hex = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, 'hex'));
export const toHex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

export interface Vector {
  protocol_name: string;
  init_prologue: string;
  init_psks?: string[];
  init_static?: string;
  init_ephemeral: string;
  init_remote_static?: string;
  resp_prologue: string;
  resp_psks?: string[];
  resp_static?: string;
  resp_ephemeral: string;
  handshake_hash?: string;
  messages: { payload: string; ciphertext: string }[];
}

export function loadVectors(file: string, sha256: string): Vector[] {
  const raw = readFileSync(join(here, 'vectors', file));
  if (createHash('sha256').update(raw).digest('hex') !== sha256)
    throw new Error(`${file}: sha256 mismatch`);
  return (JSON.parse(raw.toString('utf8')) as { vectors: Vector[] }).vectors;
}

/** Same primitives, but `generateKeyPair` hands out one fixed ephemeral (vectors, fixtures). */
export function withEphemeral(base: NoisePrimitives, privateKey: Uint8Array): NoisePrimitives {
  return {
    ...base,
    generateKeyPair: (): KeyPair => ({ privateKey, publicKey: base.publicKey(privateKey) }),
  };
}

export const blake2bPrimitives: NoisePrimitives = {
  ...noblePrimitives,
  suite: '25519_ChaChaPoly_BLAKE2b',
  hashLen: 64,
  hash: (d) => blake2b(d),
  hmac: (k, d) => hmac(blake2b, k, d),
};

export function keyPair(
  privateKey: Uint8Array,
  primitives: NoisePrimitives = noblePrimitives,
): KeyPair {
  return { privateKey, publicKey: primitives.publicKey(privateKey) };
}

/** Deterministic test bytes. */
export function seeded(label: string, length = 32): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0, at = 0; at < length; i++) {
    const block = createHash('sha256').update(`${label}/${i}`).digest();
    out.set(block.subarray(0, Math.min(32, length - at)), at);
    at += 32;
  }
  return out;
}
