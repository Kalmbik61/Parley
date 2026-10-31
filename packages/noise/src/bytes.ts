// Small byte helpers; everything returns fresh arrays and never writes into its arguments.

export const EMPTY = new Uint8Array(0);

export function concat(...parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const p of parts) length += p.length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function copy(bytes: Uint8Array): Uint8Array {
  return bytes.slice();
}

/** Constant-time for equal lengths; lengths are public. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Best-effort wipe of a secret we own. */
export function wipe(bytes: Uint8Array | null): void {
  if (bytes) bytes.fill(0);
}
