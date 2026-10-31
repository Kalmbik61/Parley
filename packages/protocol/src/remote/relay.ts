// Схема адреса relay (спека 6.6) и управляющие кадры relay (6.3).
import { z } from 'zod';
import { b64urlLength } from './b64url.js';
import { isValidRelayHost } from './qr.js';

function privateIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m === null) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([m[1], m[2], m[3], m[4]].some(x => Number(x) > 255)) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/** Частный адрес: IPv4 из 10/8, 172.16/12, 192.168/16, link-local и имена `*.local`. */
export function isPrivateRelayHost(r: string): boolean {
  const host = r.replace(/:\d+$/, '').toLowerCase();
  return privateIPv4(host) || host.endsWith('.local');
}

/** `ws://` для частного адреса и только при `allowLocal`; остальные — `wss://`. */
export function relayUrlFor(r: string, opts: { allowLocal: boolean }): string {
  if (!isValidRelayHost(r)) throw new Error('relay: invalid address');
  if (!isPrivateRelayHost(r)) return `wss://${r}`;
  if (!opts.allowLocal) throw new Error('relay: private address is not allowed in this build');
  return `ws://${r}`;
}

const b64 = (bytes: number) =>
  z.string().length(b64urlLength(bytes)).regex(/^[A-Za-z0-9_-]+$/);

export const routeIdSchema = b64(16);
export const deviceIdSchema = b64(16);
export const lookupSchema = b64(16);
export const routeSecretSchema = b64(32);
export const relayTokenSchema = b64(32);
/** sha256 токена или секрета. */
export const hashSchema = b64(32);
const streamSchema = z.string().min(1).max(64);

export const RELAY_ERROR_CODES = [
  'host_offline',
  'unknown_route',
  'unknown_device',
  'offer_closed',
  'rate_limited',
  'bad_request',
] as const;
export const relayErrorCodeSchema = z.enum(RELAY_ERROR_CODES);

// Мост → /v1/host
export const hostHelloFrame = z.strictObject({
  v: z.literal(1),
  t: z.literal('hello'),
  route: routeIdSchema,
  secret: routeSecretSchema,
});
export const hostDevicesFrame = z.strictObject({
  v: z.literal(1),
  t: z.literal('devices'),
  list: z.array(z.strictObject({ device: deviceIdSchema, tokenHash: hashSchema })).max(64),
});
export const hostOfferFrame = z.strictObject({
  v: z.literal(1),
  t: z.literal('offer'),
  lookup: lookupSchema.nullable(),
  /** Конец жизни оффера, мс эпохи. Нужен, пока `lookup` не `null`. */
  exp: z.number().int().positive().optional(),
});
export const hostFrame = z.union([hostHelloFrame, hostDevicesFrame, hostOfferFrame]);

// Relay → мост (/v1/host)
export const relayOkFrame = z.strictObject({ v: z.literal(1), t: z.literal('ok') });
export const relayIncomingFrame = z.strictObject({
  v: z.literal(1),
  t: z.literal('incoming'),
  stream: streamSchema,
  kind: z.enum(['connect', 'pair']),
  device: deviceIdSchema.optional(),
});

// Мост → /v1/accept
export const acceptFrame = z.strictObject({
  v: z.literal(1),
  t: z.literal('accept'),
  route: routeIdSchema,
  secret: routeSecretSchema,
  stream: streamSchema,
});

// Телефон → /v1/connect
export const connectFrame = z.strictObject({
  v: z.literal(1),
  t: z.literal('connect'),
  route: routeIdSchema,
  device: deviceIdSchema,
  token: relayTokenSchema,
});
export const pairFrame = z.strictObject({ v: z.literal(1), t: z.literal('pair'), lookup: lookupSchema });
export const phoneFrame = z.union([connectFrame, pairFrame]);

// Relay → телефон
export const relayReadyFrame = z.strictObject({ v: z.literal(1), t: z.literal('ready') });
export const relayErrorFrame = z.strictObject({
  v: z.literal(1),
  t: z.literal('error'),
  code: relayErrorCodeSchema,
});
