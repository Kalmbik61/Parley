import http from 'node:http';
import type { ApnsClient } from './apns.js';
import type { Limiter } from './limits.js';
import { buildApnsPayload, pushRequestSchema } from './schema.js';

export const MAX_BODY_BYTES = 4096;

export interface ServerOptions {
  apns: ApnsClient;
  limiter: Limiter;
  /** За обратным прокси клиент — последний адрес в `x-forwarded-for`. */
  trustProxy?: boolean;
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
    if (last) return last;
  }
  return req.socket.remoteAddress ?? 'unknown';
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
  });
}

export function createGatewayServer(opts: ServerOptions): http.Server {
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
    if (!opts.limiter.allowToken(r.token)) return reply(res, 429, { error: 'rate_limited' });

    const status = await opts.apns.send(r.env, r.token, r.route, buildApnsPayload(r));
    if (status === 200) return reply(res, 200, { ok: true });
    // 410 — токен недействителен: наружу как есть, мост стирает его.
    if (status === 410) return reply(res, 410, { error: 'gone' });
    if (status === 429) return reply(res, 429, { error: 'rate_limited' });
    if (status === 400) return reply(res, 400, { error: 'bad_request' });
    // Сбой самого шлюза/APNs (ключ, 5xx, сеть): не из списка A1, мост повторит позже.
    return reply(res, 502, { error: 'upstream' });
  }
  return server;
}
