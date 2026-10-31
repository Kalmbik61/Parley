import { CipherState } from './cipher.js';
import { concat, copy, utf8, wipe, EMPTY } from './bytes.js';
import type { NoisePrimitives } from './primitives.js';

/** Noise HKDF (§4.3): HMAC-based, two or three HASHLEN outputs, chaining key as the salt. */
export function noiseHkdf(
  primitives: NoisePrimitives,
  chainingKey: Uint8Array,
  ikm: Uint8Array,
  outputs: 2 | 3,
): Uint8Array[] {
  const temp = primitives.hmac(chainingKey, ikm);
  const out1 = primitives.hmac(temp, Uint8Array.of(1));
  const out2 = primitives.hmac(temp, concat(out1, Uint8Array.of(2)));
  if (outputs === 2) {
    wipe(temp);
    return [out1, out2];
  }
  const out3 = primitives.hmac(temp, concat(out2, Uint8Array.of(3)));
  wipe(temp);
  return [out1, out2, out3];
}

/** Noise SymmetricState (§5.2). */
export class SymmetricState {
  #cipher: CipherState;
  #ck: Uint8Array;
  #h: Uint8Array;

  constructor(
    private readonly primitives: NoisePrimitives,
    protocolName: string,
  ) {
    const name = utf8(protocolName);
    if (name.length <= primitives.hashLen) {
      this.#h = new Uint8Array(primitives.hashLen);
      this.#h.set(name);
    } else {
      this.#h = primitives.hash(name);
    }
    this.#ck = copy(this.#h);
    this.#cipher = new CipherState(primitives);
  }

  mixKey(ikm: Uint8Array): void {
    const [ck, tempK] = noiseHkdf(this.primitives, this.#ck, ikm, 2) as [Uint8Array, Uint8Array];
    this.#replaceKey(ck, tempK);
  }

  mixHash(data: Uint8Array): void {
    this.#h = this.primitives.hash(concat(this.#h, data));
  }

  mixKeyAndHash(ikm: Uint8Array): void {
    const [ck, tempH, tempK] = noiseHkdf(this.primitives, this.#ck, ikm, 3) as [
      Uint8Array,
      Uint8Array,
      Uint8Array,
    ];
    this.mixHash(tempH);
    this.#replaceKey(ck, tempK);
  }

  hasKey(): boolean {
    return this.#cipher.hasKey();
  }

  /** A copy of h. */
  handshakeHash(): Uint8Array {
    return copy(this.#h);
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = this.#cipher.encryptWithAd(this.#h, plaintext);
    this.mixHash(ciphertext);
    return ciphertext;
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plaintext = this.#cipher.decryptWithAd(this.#h, ciphertext);
    this.mixHash(ciphertext);
    return plaintext;
  }

  /** Two transport ciphers (initiator→responder, responder→initiator). Wipes the chaining key. */
  split(): [CipherState, CipherState] {
    const [k1, k2] = noiseHkdf(this.primitives, this.#ck, EMPTY, 2) as [Uint8Array, Uint8Array];
    const c1 = new CipherState(this.primitives, k1.subarray(0, 32));
    const c2 = new CipherState(this.primitives, k2.subarray(0, 32));
    wipe(k1);
    wipe(k2);
    wipe(this.#ck);
    this.#cipher.destroy();
    return [c1, c2];
  }

  // The cipher is replaced rather than re-keyed so that its nonce restarts at zero (InitializeKey).
  #replaceKey(ck: Uint8Array, tempK: Uint8Array): void {
    wipe(this.#ck);
    this.#ck = ck;
    const key = tempK.subarray(0, 32);
    this.#cipher.destroy();
    this.#cipher = new CipherState(this.primitives, key);
    wipe(tempK);
  }
}
