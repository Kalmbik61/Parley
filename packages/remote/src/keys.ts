import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { generateKeyPair, noblePrimitives } from '@parley/noise';
import {
  b64urlDecode,
  b64urlEncode,
  routeIdSchema,
  routeSecretSchema,
} from '@parley/protocol/remote';
import { readJsonFile, writeJsonAtomic } from './files.js';

/**
 * Bridge identity (spec §5.2, §7.2): the static X25519 key HS and the relay route. `routeId` is kept here with
 * `routeSecret` — not in remote.json — so a reset replaces the key and the route in one atomic write.
 */
export interface BridgeKeys {
  hsPriv: Uint8Array;
  hsPub: Uint8Array;
  routeId: string;
  routeSecret: string;
}

const key32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const keysFile = z.strictObject({
  v: z.literal(1),
  hsPriv: key32,
  hsPub: key32,
  routeId: routeIdSchema,
  routeSecret: routeSecretSchema,
});

export function newBridgeKeys(): BridgeKeys {
  const hs = generateKeyPair();
  return {
    hsPriv: hs.privateKey,
    hsPub: hs.publicKey,
    routeId: b64urlEncode(randomBytes(16)),
    routeSecret: b64urlEncode(randomBytes(32)),
  };
}

export async function writeBridgeKeys(file: string, keys: BridgeKeys): Promise<void> {
  await writeJsonAtomic(file, {
    v: 1,
    hsPriv: b64urlEncode(keys.hsPriv),
    hsPub: b64urlEncode(keys.hsPub),
    routeId: keys.routeId,
    routeSecret: keys.routeSecret,
  });
}

/** Reads keys.json; creates it on first start. A damaged file throws (no silent new identity). */
export async function loadBridgeKeys(file: string): Promise<BridgeKeys> {
  const raw = await readJsonFile(file);
  if (raw === undefined) {
    const keys = newBridgeKeys();
    await writeBridgeKeys(file, keys);
    return keys;
  }
  const parsed = keysFile.safeParse(raw);
  if (!parsed.success) throw new Error('keys.json is invalid');
  const hsPriv = b64urlDecode(parsed.data.hsPriv);
  const hsPub = b64urlDecode(parsed.data.hsPub);
  const derived = noblePrimitives.publicKey(hsPriv);
  if (Buffer.compare(Buffer.from(derived), Buffer.from(hsPub)) !== 0)
    throw new Error('keys.json key pair mismatch');
  return { hsPriv, hsPub, routeId: parsed.data.routeId, routeSecret: parsed.data.routeSecret };
}

/** `b64url(SHA-256("parley-host-v1" ‖ HS_pub)[0:16])` (spec §7.2). */
export function hostIdFor(hsPub: Uint8Array): string {
  const digest = createHash('sha256').update('parley-host-v1').update(hsPub).digest();
  return b64urlEncode(digest.subarray(0, 16));
}

/** sha256 of the raw bytes behind a b64url token, as b64url (relay `tokenHash`). */
export function tokenHash(tokenB64: string): string {
  return b64urlEncode(createHash('sha256').update(b64urlDecode(tokenB64)).digest());
}
