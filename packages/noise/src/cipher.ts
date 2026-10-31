import { NoiseError } from './errors.js';
import type { NoisePrimitives } from './primitives.js';
import { copy, wipe } from './bytes.js';

/** Noise reserves 2^64−1 (§5.1): a cipher refuses to use it. */
export const MAX_NONCE = 0xffff_ffff_ffff_ffffn;
/** From this nonce on `shouldClose` is true: the bridge closes the session (spec §7.6). */
export const CLOSE_NONCE = 0x1_0000_0000n;

/** ChaChaPoly nonce (Noise §12.3): 4 zero bytes and the 64-bit counter, little-endian. */
export function noiseNonce(n: bigint): Uint8Array {
  const out = new Uint8Array(12);
  const view = new DataView(out.buffer);
  view.setUint32(4, Number(n & 0xffff_ffffn), true);
  view.setUint32(8, Number(n >> 32n), true);
  return out;
}

/**
 * Noise CipherState (§5.1): a key and a strictly increasing nonce. A failed decryption does not advance the
 * nonce, so the caller cannot skip past a bad message; transport callers close the session on any error.
 */
export class CipherState {
  #k: Uint8Array | null;
  #n = 0n;
  #destroyed = false;

  constructor(
    private readonly primitives: NoisePrimitives,
    key: Uint8Array | null = null,
  ) {
    if (key && key.length !== 32) throw new NoiseError('key', 'cipher key must be 32 bytes');
    this.#k = key ? copy(key) : null;
  }

  hasKey(): boolean {
    return this.#k !== null;
  }

  /** The next nonce to be used. */
  get nonce(): bigint {
    return this.#n;
  }

  /** True once 2^32 messages went through this cipher: time to close the session and handshake again. */
  get shouldClose(): boolean {
    return this.#n >= CLOSE_NONCE;
  }

  /** Noise SetNonce(). Exposed for tests of the nonce limits; transport code never calls it. */
  setNonce(n: bigint): void {
    this.#checkAlive();
    if (n < 0n || n > MAX_NONCE) throw new NoiseError('nonce', 'nonce out of range');
    this.#n = n;
  }

  /** With no key the plaintext is returned as a copy (Noise §5.1). */
  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    this.#checkAlive();
    if (!this.#k) return copy(plaintext);
    this.#checkNonce();
    const out = this.primitives.encrypt(this.#k, noiseNonce(this.#n), ad, plaintext);
    this.#n += 1n;
    return out;
  }

  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    this.#checkAlive();
    if (!this.#k) return copy(ciphertext);
    this.#checkNonce();
    if (ciphertext.length < 16) throw new NoiseError('decrypt', 'decryption failed');
    const out = this.primitives.decrypt(this.#k, noiseNonce(this.#n), ad, ciphertext);
    this.#n += 1n;
    return out;
  }

  /** Forget the key; every later call throws (it never falls back to plaintext). */
  destroy(): void {
    wipe(this.#k);
    this.#k = null;
    this.#destroyed = true;
  }

  #checkAlive(): void {
    if (this.#destroyed) throw new NoiseError('state', 'cipher destroyed');
  }

  #checkNonce(): void {
    if (this.#n >= MAX_NONCE) throw new NoiseError('nonce', 'nonce exhausted');
  }
}
