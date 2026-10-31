import { NoiseError } from './errors.js';

interface RandomSource {
  getRandomValues<T extends ArrayBufferView>(array: T): T;
}

// getRandomValues fills at most 65 536 bytes per call (Web Crypto).
const MAX_CHUNK = 65_536;

/**
 * Secure random bytes from `globalThis.crypto.getRandomValues`: Web Crypto in browsers and on Node,
 * `expo-crypto` / `react-native-get-random-values` in React Native. Throws when no source is installed —
 * there is no fallback to `Math.random`.
 */
export function randomBytes(length: number): Uint8Array {
  const source = (globalThis as { crypto?: Partial<RandomSource> }).crypto;
  if (!source || typeof source.getRandomValues !== 'function') {
    throw new NoiseError('random', 'globalThis.crypto.getRandomValues is not available');
  }
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += MAX_CHUNK) {
    source.getRandomValues(out.subarray(i, Math.min(length, i + MAX_CHUNK)));
  }
  return out;
}
