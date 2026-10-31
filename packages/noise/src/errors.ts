/** Why a Noise operation failed. Messages never carry key material, payloads or ciphertext. */
export type NoiseErrorCode =
  | 'decrypt' // AEAD tag did not verify (wrong key, wrong psk, tampered, truncated, reordered or replayed)
  | 'state' // call out of turn, after completion or after an earlier failure
  | 'size' // message or argument length out of bounds
  | 'nonce' // nonce counter exhausted
  | 'key' // bad key length, low-order point, or remote static key not the expected one
  | 'frame' // malformed transport frame (flags, chunk order)
  | 'ceiling' // frame exceeds its configured ceiling (before or after decompression)
  | 'random'; // no secure random source

export class NoiseError extends Error {
  override readonly name = 'NoiseError';
  constructor(
    readonly code: NoiseErrorCode,
    message: string,
  ) {
    super(message);
  }
}
