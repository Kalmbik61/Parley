import { pushRequestSchema } from '@parley/protocol/remote';
import type { BridgeLog } from './log.js';

/**
 * Адрес push-шлюза, зашитый в сборку (спека 6.5). Шлюз заработает после оплаты аккаунта Apple Developer; пока адреса нет —
 * `null`, и мост push не шлёт. `remote.json.pushGatewayUrl` переопределяет его (своя сборка под свой bundle ID).
 */
export const DEFAULT_PUSH_GATEWAY_URL: string | null = null;

/** Адрес шлюза: переопределение из `remote.json`, иначе адрес сборки. Только `https:` (и `http:` для петли — тесты, разработка). */
export function resolvePushGatewayUrl(override: string | null | undefined, fallback: string | null = DEFAULT_PUSH_GATEWAY_URL): string | null {
  const raw = override ?? fallback;
  if (raw === null) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null;
  return url.origin;
}

/**
 * Итог запроса к шлюзу. `invalid-token` — 410: токен стереть. `rejected` — 400 или 429: запрос не принят, повтора нет.
 * `unavailable` — шлюз не ответил или ответил 5xx: пропуск без повтора.
 */
export type PushResult = 'sent' | 'invalid-token' | 'rejected' | 'unavailable';

export interface PushRequest {
  token: string;
  env: 'sandbox' | 'production';
  count: number;
  route: string;
}

export interface PushGatewayClient {
  send(request: PushRequest): Promise<PushResult>;
}

export interface PushGatewayClientOptions {
  /** `resolvePushGatewayUrl(...)`, не `null`. */
  url: string;
  log: BridgeLog;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** `POST /v1/push` (спека 6.5). В тело идут только поля схемы шлюза; токен нигде не пишется, в лог идёт статус. */
export function createPushGatewayClient(options: PushGatewayClientOptions): PushGatewayClient {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const endpoint = `${options.url.replace(/\/+$/, '')}/v1/push`;
  return {
    async send(request) {
      const body = pushRequestSchema.safeParse({
        v: 1,
        token: request.token.toLowerCase(),
        env: request.env,
        count: Math.min(Math.max(0, Math.trunc(request.count)), 9999),
        route: request.route,
      });
      if (!body.success) {
        options.log.warn('push.bad_request');
        return 'rejected';
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await doFetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body.data),
          signal: controller.signal,
        });
        if (res.status === 200) return 'sent';
        if (res.status === 410) return 'invalid-token';
        if (res.status === 400 || res.status === 429) {
          options.log.warn('push.rejected', { status: res.status });
          return 'rejected';
        }
        options.log.warn('push.gateway_status', { status: res.status });
        return 'unavailable';
      } catch {
        options.log.warn('push.gateway_unavailable');
        return 'unavailable';
      } finally {
        clearTimeout(timer);
        // Тело ответа не читается: шлюз ничего полезного не отдаёт.
      }
    },
  };
}
