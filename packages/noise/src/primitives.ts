import { x25519 } from '@noble/curves/ed25519.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { NoiseError } from './errors.js';
import { randomBytes } from './random.js';

export interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

/**
 * Everything the state machine needs from cryptography (Noise §4). A second implementation — for example
 * `react-native-quick-crypto` in the app — plugs in here without touching the state machine, and must
 * reproduce the same test vectors first.
 *
 * Contract: no method writes into its arguments; every result is a fresh array.
 */
export interface NoisePrimitives {
  /** The `<DH>_<cipher>_<hash>` part of the protocol name, e.g. `25519_ChaChaPoly_SHA256`. */
  readonly suite: string;
  /** DHLEN: 32 for X25519. */
  readonly dhLen: number;
  /** HASHLEN: 32 for SHA-256. */
  readonly hashLen: number;
  /** A fresh key pair from a secure random source (used for ephemerals). */
  generateKeyPair(): KeyPair;
  publicKey(privateKey: Uint8Array): Uint8Array;
  /** X25519; must throw on an all-zero result (low-order public key). */
  dh(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array;
  /** AEAD with a 96-bit nonce built from `n` by the caller's cipher rules (see `noiseNonce`). */
  encrypt(key: Uint8Array, nonce: Uint8Array, ad: Uint8Array, plaintext: Uint8Array): Uint8Array;
  /** Throws on a tag mismatch. */
  decrypt(key: Uint8Array, nonce: Uint8Array, ad: Uint8Array, ciphertext: Uint8Array): Uint8Array;
  hash(data: Uint8Array): Uint8Array;
  hmac(key: Uint8Array, data: Uint8Array): Uint8Array;
}

/** The frozen suite (spec §7.1, S7): X25519, ChaCha20-Poly1305, SHA-256 on `@noble`. */
export const noblePrimitives: NoisePrimitives = Object.freeze({
  suite: '25519_ChaChaPoly_SHA256',
  dhLen: 32,
  hashLen: 32,
  generateKeyPair(): KeyPair {
    const privateKey = randomBytes(32);
    return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
  },
  publicKey(privateKey: Uint8Array): Uint8Array {
    return x25519.getPublicKey(privateKey);
  },
  dh(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
    try {
      return x25519.getSharedSecret(privateKey, publicKey);
    } catch {
      throw new NoiseError('key', 'invalid X25519 key');
    }
  },
  encrypt(key: Uint8Array, nonce: Uint8Array, ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    return chacha20poly1305(key, nonce, ad).encrypt(plaintext);
  },
  decrypt(key: Uint8Array, nonce: Uint8Array, ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    try {
      return chacha20poly1305(key, nonce, ad).decrypt(ciphertext);
    } catch {
      throw new NoiseError('decrypt', 'decryption failed');
    }
  },
  hash: (data: Uint8Array): Uint8Array => sha256(data),
  hmac: (key: Uint8Array, data: Uint8Array): Uint8Array => hmac(sha256, key, data),
});
