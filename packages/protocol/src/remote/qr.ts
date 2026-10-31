// Оффер и QR паринга (спека 7.3): parley://pair?v=1&k=<b64url HS_pub>&s=<b64url s>&r=<host[:port]>
import { b64urlDecode, b64urlEncode, b64urlLength } from './b64url.js';

export const PAIR_URL_PREFIX = 'parley://pair?';
export const PAIR_KEY_BYTES = 32;
export const PAIR_SECRET_BYTES = 16;
export const RELAY_HOST_MAX = 64;

export interface PairOffer {
  /** Публичный статический ключ хоста (моста), 32 байта. */
  k: Uint8Array;
  /** Секрет оффера, 16 байт. */
  s: Uint8Array;
  /** Адрес relay: `host[:port]`, без схемы и пути. */
  r: string;
}

const RELAY_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::(\d{1,5}))?$/;

/** Ошибки не содержат значений из URL: `s` — секрет. */
export function isValidRelayHost(r: string): boolean {
  if (r.length === 0 || r.length > RELAY_HOST_MAX) return false;
  const m = RELAY_RE.exec(r);
  if (m === null) return false;
  if (m[1] !== undefined) {
    const port = Number(m[1]);
    if (port < 1 || port > 65535) return false;
  }
  return true;
}

export function buildPairUrl(offer: PairOffer): string {
  if (offer.k.length !== PAIR_KEY_BYTES) throw new Error('pair url: k must be 32 bytes');
  if (offer.s.length !== PAIR_SECRET_BYTES) throw new Error('pair url: s must be 16 bytes');
  if (!isValidRelayHost(offer.r)) throw new Error('pair url: invalid relay');
  return `${PAIR_URL_PREFIX}v=1&k=${b64urlEncode(offer.k)}&s=${b64urlEncode(offer.s)}&r=${offer.r}`;
}

export function parsePairUrl(url: string): PairOffer {
  if (!url.startsWith(PAIR_URL_PREFIX)) throw new Error('pair url: wrong scheme');
  const fields: Record<string, string> = {};
  for (const part of url.slice(PAIR_URL_PREFIX.length).split('&')) {
    const eq = part.indexOf('=');
    if (eq <= 0) throw new Error('pair url: malformed query');
    const key = part.slice(0, eq);
    if (key !== 'v' && key !== 'k' && key !== 's' && key !== 'r') throw new Error('pair url: unknown field');
    if (Object.prototype.hasOwnProperty.call(fields, key)) throw new Error('pair url: duplicate field');
    fields[key] = part.slice(eq + 1);
  }
  if (fields.v !== '1') throw new Error('pair url: unsupported version');
  const { k, s, r } = fields;
  if (k === undefined || s === undefined || r === undefined) throw new Error('pair url: missing field');
  if (k.length !== b64urlLength(PAIR_KEY_BYTES)) throw new Error('pair url: k must be 32 bytes');
  if (s.length !== b64urlLength(PAIR_SECRET_BYTES)) throw new Error('pair url: s must be 16 bytes');
  let kb: Uint8Array;
  let sb: Uint8Array;
  try {
    kb = b64urlDecode(k);
    sb = b64urlDecode(s);
  } catch {
    throw new Error('pair url: invalid base64url');
  }
  if (!isValidRelayHost(r)) throw new Error('pair url: invalid relay');
  return { k: kb, s: sb, r };
}
