import { createPrivateKey, sign, type KeyObject } from 'node:crypto';

/** Apple просит обновлять токен не чаще раза в 20 мин и не реже раза в час. */
export const JWT_TTL_MS = 50 * 60 * 1000;
/** Принудительная замена после 403 — только для токена не моложе этого (иначе `TooManyProviderTokenUpdates`). */
export const JWT_MIN_REFRESH_MS = 20 * 60 * 1000;

export interface JwtOptions {
  /** PEM содержимое `.p8`. */
  keyPem: string;
  keyId: string;
  teamId: string;
  /** Стенные часы: только для `iat`. */
  now?: () => number;
  /** Монотонные часы: возраст токена (ревью A5, M3 — шаг стенных часов назад не продлевает токен). */
  monotonic?: () => number;
}

/** Текущий токен; `refresh()` сбрасывает его, если он не моложе 20 мин, и говорит, удалось ли. */
export interface JwtProvider {
  (): string;
  refresh(): boolean;
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

/** Провайдер JWT: один токен на 50 минут по монотонным часам, потом новый. */
export function createJwtProvider(opts: JwtOptions): JwtProvider {
  const key = parseKey(opts.keyPem);
  const now = opts.now ?? Date.now;
  const monotonic = opts.monotonic ?? (() => performance.now());
  const header = b64u(JSON.stringify({ alg: 'ES256', kid: opts.keyId }));
  let cached: { token: string; at: number } | undefined;
  const get = (): string => {
    const m = monotonic();
    if (cached && m - cached.at < JWT_TTL_MS) return cached.token;
    const payload = b64u(JSON.stringify({ iss: opts.teamId, iat: Math.floor(now() / 1000) }));
    const input = `${header}.${payload}`;
    // JOSE ждёт «сырую» подпись r||s, а не DER.
    const sig = sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
    cached = { token: `${input}.${b64u(sig)}`, at: m };
    return cached.token;
  };
  const refresh = (): boolean => {
    if (cached && monotonic() - cached.at < JWT_MIN_REFRESH_MS) return false;
    cached = undefined;
    return true;
  };
  return Object.assign(get, { refresh });
}
