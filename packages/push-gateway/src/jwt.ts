import { createPrivateKey, sign, type KeyObject } from 'node:crypto';

/** Apple просит обновлять токен не чаще раза в 20 мин и не реже раза в час. */
export const JWT_TTL_MS = 50 * 60 * 1000;

export interface JwtOptions {
  /** PEM содержимое `.p8`. */
  keyPem: string;
  keyId: string;
  teamId: string;
  now?: () => number;
}

const b64u = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

/** Читает ключ ES256 (P-256); текст ошибки не содержит ключа. */
export function parseKey(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new Error('APNs key is not a valid PEM private key');
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('APNs key must be an EC P-256 key');
  }
  return key;
}

/** Провайдер JWT: один токен на 50 минут, потом новый. */
export function createJwtProvider(opts: JwtOptions): () => string {
  const key = parseKey(opts.keyPem);
  const now = opts.now ?? Date.now;
  const header = b64u(JSON.stringify({ alg: 'ES256', kid: opts.keyId }));
  let cached: { token: string; at: number } | undefined;
  return () => {
    const t = now();
    if (cached && t - cached.at < JWT_TTL_MS) return cached.token;
    const payload = b64u(JSON.stringify({ iss: opts.teamId, iat: Math.floor(t / 1000) }));
    const input = `${header}.${payload}`;
    // JOSE ждёт «сырую» подпись r||s, а не DER.
    const sig = sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
    cached = { token: `${input}.${b64u(sig)}`, at: t };
    return cached.token;
  };
}
