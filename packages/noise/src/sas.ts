import { NoiseError } from './errors.js';
import { hkdf } from './hkdf.js';

export const SAS_INFO = 'parley-sas-v1';

/**
 * Short authentication string of a finished pairing handshake (spec §7.4):
 * `uint32_be(HKDF(h, info "parley-sas-v1", 4)) mod 10^6`, as six digits with leading zeros.
 * `h` must be the hash of the completed handshake (after msg2), never of msg1 alone.
 */
export function sas(h: Uint8Array): string {
  if (h.length !== 32) throw new NoiseError('size', 'handshake hash must be 32 bytes');
  const out = hkdf(h, SAS_INFO, 4);
  const value = new DataView(out.buffer, out.byteOffset, 4).getUint32(0, false) % 1_000_000;
  return value.toString().padStart(6, '0');
}
