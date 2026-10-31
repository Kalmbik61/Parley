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
  jwt: () => string;
  /** Доп. опции TLS для http2.connect (мок использует самоподписанный сертификат). */
  connectOptions?: http2.SecureClientSessionOptions;
  timeoutMs?: number;
}

export interface ApnsClient {
  /** HTTP-статус APNs; сетевая ошибка и таймаут — 0. */
  send(env: ApnsEnv, token: string, route: string, payload: unknown): Promise<number>;
  close(): void;
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

  return {
    send(env, token, route, payload) {
      return new Promise<number>((resolve) => {
        let done = false;
        const finish = (status: number) => {
          if (done) return;
          done = true;
          resolve(status);
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
          let status = 0;
          req.setTimeout(timeoutMs, () => {
            req.close(http2.constants.NGHTTP2_CANCEL);
            finish(0);
          });
          req.on('response', (h) => {
            status = Number(h[':status'] ?? 0);
          });
          // Тело ответа APNs (reason) не читаем и не храним.
          req.resume();
          req.on('end', () => finish(status));
          req.on('error', () => finish(0));
          req.on('close', () => finish(status));
          req.end(JSON.stringify(payload));
        } catch {
          finish(0);
        }
      });
    },
    close() {
      for (const s of sessions.values()) s.destroy();
      sessions.clear();
    },
  };
}
