import http from 'node:http';
import type { ApnsClient } from './apns.js';
import { ipKey } from './ip.js';
import type { Limiter } from './limits.js';
import { buildApnsPayload, pushRequestSchema } from './schema.js';

export const MAX_BODY_BYTES = 4096;
/** Сводка ответов APNs в журнал — раз в минуту и при остановке. */
export const APNS_LOG_INTERVAL_MS = 60_000;
/** 400 APNs из-за самого токена: постоянно, мост его стирает (ревью A5, m2). */
const TOKEN_REASONS = new Set(['BadDeviceToken', 'DeviceTokenNotForTopic']);
/** 400 APNs из-за настройки шлюза: мосту не исправить. */
const CONFIG_REASONS = new Set([
  'BadTopic',
  'TopicDisallowed',
  'MissingTopic',
  'BadCertificate',
  'BadCertificateEnvironment',
]);

export interface ServerOptions {
  apns: ApnsClient;
  limiter: Limiter;
  /** За обратным прокси клиент — последний адрес в `x-forwarded-for`. */
  trustProxy?: boolean;
  /** Журнал: только сводка `status`/`reason` APNs, без токенов, маршрутов и адресов (ревью A5, M3). */
  log?: (line: string) => void;
  logIntervalMs?: number;
}

function reply(res: http.ServerResponse, status: number, body: object): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

function clientIp(req: http.IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    const last = (Array.isArray(xff) ? xff.join(',') : xff)?.split(',').pop()?.trim();
    if (last) return ipKey(last);
  }
  return ipKey(req.socket.remoteAddress ?? 'unknown');
}

/** Читает тело не больше лимита; null — слишком большое. */
function readBody(req: http.IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        chunks.length = 0;
        req.pause();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(null));
    // Клиент оборвал запрос: промис не висит до `requestTimeout` (ревью A5, m3). После `end` это ничего не меняет.
    req.on('aborted', () => resolve(null));
    req.on('close', () => resolve(null));
  });
}

export function createGatewayServer(opts: ServerOptions): http.Server {
  const counts = new Map<string, number>();
  const flushLog = (): void => {
    if (counts.size === 0 || !opts.log) return;
    const parts = [...counts].map(([k, n]) => `${k} x${n}`);
    counts.clear();
    opts.log(`push-gateway: apns ${parts.join(', ')}`);
  };
  const logTimer = setInterval(flushLog, opts.logIntervalMs ?? APNS_LOG_INTERVAL_MS);
  logTimer.unref();
  const server = http.createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) reply(res, 502, { error: 'upstream' });
      else res.destroy();
    });
  });
  // Разумные таймауты: медленные клиенты не держат сокеты.
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 50;
  server.maxRequestsPerSocket = 100;
  server.on('close', () => {
    clearInterval(logTimer);
    flushLog();
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const path = (req.url ?? '').split('?')[0];
    if (path === '/v1/health') {
      if (req.method !== 'GET') return reply(res, 405, { error: 'method' });
      return reply(res, 200, { ok: true });
    }
    if (path !== '/v1/push') return reply(res, 404, { error: 'not_found' });
    if (req.method !== 'POST') return reply(res, 405, { error: 'method' });

    if (!opts.limiter.allowIp(clientIp(req, opts.trustProxy ?? false))) {
      req.resume();
      return reply(res, 429, { error: 'rate_limited' });
    }
    const raw = await readBody(req);
    if (raw === null) {
      res.setHeader('connection', 'close');
      return reply(res, 400, { error: 'bad_request' });
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return reply(res, 400, { error: 'bad_request' });
    }
    const parsed = pushRequestSchema.safeParse(json);
    if (!parsed.success) return reply(res, 400, { error: 'bad_request' });
    const r = parsed.data;
    // Регистр hex не должен давать новое окно лимита (ревью A5, M4); APNs получает тот же вид.
    const token = r.token.toLowerCase();
    if (!opts.limiter.allowToken(token)) return reply(res, 429, { error: 'rate_limited' });

    const { status, reason, retriedAfter } = await opts.apns.send(
      r.env,
      token,
      r.route,
      buildApnsPayload(r),
    );
    const count = (key: string): void => void counts.set(key, (counts.get(key) ?? 0) + 1);
    if (retriedAfter !== null) count(`403 ${retriedAfter}`);
    count(`${status} ${reason ?? '-'}`);
    if (status === 200) return reply(res, 200, { ok: true });
    // 410 — токен недействителен: наружу как есть, мост стирает его. Постоянные 400 из-за токена — так же.
    if (status === 410 || (status === 400 && reason !== null && TOKEN_REASONS.has(reason))) {
      return reply(res, 410, { error: 'gone' });
    }
    if (status === 429) return reply(res, 429, { error: 'rate_limited' });
    if (status === 400 && !(reason !== null && CONFIG_REASONS.has(reason)))
      return reply(res, 400, { error: 'bad_request' });
    // Сбой самого шлюза/APNs (ключ, 5xx, сеть): не из списка A1, мост повторит позже.
    return reply(res, 502, { error: 'upstream' });
  }
  return server;
}
