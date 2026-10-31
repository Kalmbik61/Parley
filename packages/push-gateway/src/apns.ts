import http2 from 'node:http2';

export const APNS_ORIGINS = {
  sandbox: 'https://api.sandbox.push.apple.com',
  production: 'https://api.push.apple.com',
} as const;

export type ApnsEnv = keyof typeof APNS_ORIGINS;

export interface ApnsOptions {
  /** Подменяется в тестах на локальный мок. */
  origins?: Record<ApnsEnv, string>;
  topic: string;
  /** Текущий JWT; `refresh` — сбросить его после 403 (см. `JwtProvider`). */
  jwt: (() => string) & { refresh?: () => boolean };
  /** Доп. опции TLS для http2.connect (мок использует самоподписанный сертификат). */
  connectOptions?: http2.SecureClientSessionOptions;
  timeoutMs?: number;
}

export interface ApnsResult {
  /** HTTP-статус APNs; сетевая ошибка и таймаут — 0. */
  status: number;
  /** `reason` из тела ответа APNs (только буквы, иначе `null`); тело живёт только в памяти. */
  reason: string | null;
  /** Причина 403, после которой JWT сменён и запрос повторён; иначе `null`. */
  retriedAfter: string | null;
}

export interface ApnsClient {
  /** Ответ на 403 с истёкшим или неверным JWT — новый JWT и один повтор (ревью A5, M3). */
  send(env: ApnsEnv, token: string, route: string, payload: unknown): Promise<ApnsResult>;
  close(): void;
}

/** Причины 403, после которых JWT меняется. */
const PROVIDER_TOKEN_REASONS = new Set(['ExpiredProviderToken', 'InvalidProviderToken']);
const MAX_REASON_BODY = 512;

function reasonOf(body: string): string | null {
  try {
    const reason = (JSON.parse(body) as { reason?: unknown }).reason;
    return typeof reason === 'string' && /^[A-Za-z]{1,64}$/.test(reason) ? reason : null;
  } catch {
    return null;
  }
}

export function createApnsClient(opts: ApnsOptions): ApnsClient {
  const origins = opts.origins ?? APNS_ORIGINS;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const sessions = new Map<ApnsEnv, http2.ClientHttp2Session>();

  const session = (env: ApnsEnv): http2.ClientHttp2Session => {
    const cur = sessions.get(env);
    if (cur && !cur.closed && !cur.destroyed) return cur;
    const s = http2.connect(origins[env], opts.connectOptions);
    s.on('error', () => s.destroy());
    s.on('close', () => {
      if (sessions.get(env) === s) sessions.delete(env);
    });
    sessions.set(env, s);
    return s;
  };

  const once = (
    env: ApnsEnv,
    token: string,
    route: string,
    payload: unknown,
  ): Promise<ApnsResult> =>
    new Promise<ApnsResult>((resolve) => {
      let done = false;
      let status = 0;
      let body = '';
      const finish = (s: number) => {
        if (done) return;
        done = true;
        resolve({
          status: s,
          reason: s === 0 || s === 200 ? null : reasonOf(body),
          retriedAfter: null,
        });
      };
      try {
        const req = session(env).request({
          ':method': 'POST',
          ':path': `/3/device/${token}`,
          authorization: `bearer ${opts.jwt()}`,
          'apns-topic': opts.topic,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'apns-collapse-id': route,
          'content-type': 'application/json',
        });
        req.setTimeout(timeoutMs, () => {
          req.close(http2.constants.NGHTTP2_CANCEL);
          finish(0);
        });
        req.on('response', (h) => {
          status = Number(h[':status'] ?? 0);
        });
        // Тело ответа (`{"reason": …}`) читается в память ради кода причины и нигде не хранится.
        req.setEncoding('utf8');
        req.on('data', (chunk: string) => {
          if (body.length < MAX_REASON_BODY) body += chunk.slice(0, MAX_REASON_BODY - body.length);
        });
        req.on('end', () => finish(status));
        req.on('error', () => finish(0));
        req.on('close', () => finish(status));
        req.end(JSON.stringify(payload));
      } catch {
        finish(0);
      }
    });

  return {
    async send(env, token, route, payload) {
      const first = await once(env, token, route, payload);
      if (
        first.status !== 403 ||
        first.reason === null ||
        !PROVIDER_TOKEN_REASONS.has(first.reason)
      )
        return first;
      // Не чаще раза в 20 мин: иначе APNs ответит `TooManyProviderTokenUpdates`.
      if (opts.jwt.refresh?.() !== true) return first;
      return { ...(await once(env, token, route, payload)), retriedAfter: first.reason };
    },
    close() {
      for (const s of sessions.values()) s.destroy();
      sessions.clear();
    },
  };
}
