export { NoiseError, type NoiseErrorCode } from './errors.js';
export { noblePrimitives, type KeyPair, type NoisePrimitives } from './primitives.js';
export { CipherState, MAX_NONCE, CLOSE_NONCE, noiseNonce } from './cipher.js';
export { SymmetricState, noiseHkdf } from './symmetric.js';
export { PATTERNS, type HandshakePattern, type PatternName, type Token } from './patterns.js';
export {
  HandshakeState,
  initiator,
  responder,
  MAX_MESSAGE,
  type HandshakeOptions,
  type TransportCiphers,
} from './handshake.js';
export { FrameCodec, FLAG_LAST, FLAG_DEFLATE, MAX_CHUNK, type FrameCodecOptions } from './codec.js';
export { hkdf, derivePairKeys, PAIR_PSK_INFO, PAIR_LOOKUP_INFO } from './hkdf.js';
export { sas, SAS_INFO } from './sas.js';
export { randomBytes } from './random.js';

import { noblePrimitives } from './primitives.js';
import type { KeyPair } from './primitives.js';

/** A fresh X25519 key pair on the default primitives (statics such as HS and DS_h). */
export function generateKeyPair(): KeyPair {
  return noblePrimitives.generateKeyPair();
}
