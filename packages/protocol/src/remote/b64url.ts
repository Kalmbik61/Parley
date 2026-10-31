// Base64url без дополнения на Uint8Array: Hermes и браузер не имеют Buffer.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const LOOKUP: Record<string, number> = {};
for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET.charAt(i)] = i;

export function b64urlEncode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]! + ALPHABET[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]!;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]!;
  }
  return out;
}

/** Строгий разбор: только алфавит base64url, без `=`, и канонический вид (нулевые хвостовые биты). */
export function b64urlDecode(text: string): Uint8Array {
  if (text.length % 4 === 1) throw new Error('invalid base64url');
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let pos = 0;
  for (let i = 0; i < text.length; i++) {
    const v = LOOKUP[text.charAt(i)];
    if (v === undefined) throw new Error('invalid base64url');
    acc = ((acc << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[pos++] = (acc >> bits) & 0xff;
    }
  }
  if ((acc & ((1 << bits) - 1)) !== 0) throw new Error('invalid base64url');
  return out;
}

/** Длина base64url-строки для n байт. */
export function b64urlLength(bytes: number): number {
  return Math.ceil((bytes * 4) / 3);
}
