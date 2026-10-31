import { randomBytes } from 'node:crypto';
import http from 'node:http';
import {
  acceptFrame,
  b64urlEncode,
  connectFrame,
  hostFrame,
  pairFrame,
  type RELAY_ERROR_CODES,
} from '@parley/protocol/remote';
import { WebSocket, WebSocketServer } from 'ws';
import { handleHttp } from './health.js';
import { ipKey } from './ip.js';
import { Limiter } from './limits.js';
import { createLogger, type Logger } from './log.js';
import { DEFAULT_TIMING, Heartbeat, closeSoft, splice, type Timing } from './pipe.js';
import {
  MAX_OFFER_MS,
  MAX_STREAMS_PER_ROUTE,
  Registry,
  hashMatches,
  sha256OfB64,
  type Host,
} from './routes.js';
import { MAX_ROUTES, type Store } from './store.js';

/**
 * Одновременных соединений с одного адреса (IPv6 — с одной /64), считая upgrade (ревью A4, M1). Мост и телефоны за
 * одним NAT в пике: управление, до 10 потоков `accept` и до 10 телефонов — 21; 32 оставляют запас.
 */
export const MAX_CONNECTIONS_PER_IP = 32;
/** Сборка мусора маршрутов раз в час. */
export const GC_INTERVAL_MS = 3_600_000;

/** Бинарный кадр ≤ 65 535 + 64 байт (спека 6.4); больше — закрытие соединения. */
export const MAX_FRAME_BYTES = 65_535 + 64;
/** Управляющие кадры до склейки намного короче. */
const MAX_CONTROL_BYTES = 16 * 1024;

type ErrorCode = (typeof RELAY_ERROR_CODES)[number];

export interface RelayOptions {
  store: Store;
  limiter?: Limiter;
  log?: Logger;
  /** За обратным прокси клиент — последний адрес в `x-forwarded-for`. */
  trustProxy?: boolean;
  timing?: Partial<Timing>;
  maxConnections?: number;
  maxConnectionsPerIp?: number;
  now?: () => number;
}

export interface Relay {
  server: http.Server;
  registry: Registry;
  heartbeat: Heartbeat;
  close(): Promise<void>;
}

function clientIp(req: http.IncomingMessage, trustProxy: boolean): string {
  let ip = req.socket.remoteAddress ?? 'unknown';
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    const last = (Array.isArray(xff) ? xff.join(',') : xff)?.split(',').pop()?.trim();
    if (last) ip = last;
  }
  return ipKey(ip);
}

function sendJson(ws: WebSocket, body: object): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(body));
}

/** Неаутентифицированный сигнал (спека 6.3): код и закрытие. */
function fail(ws: WebSocket, code: ErrorCode): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ v: 1, t: 'error', code }), () => closeSoft(ws, 1000));
}

function parseControl(data: unknown, isBinary: boolean, max: number): unknown {
  if (isBinary || !Buffer.isBuffer(data) || data.length > max) return undefined;
  try {
    return JSON.parse(data.toString('utf8'));
  } catch {
    return undefined;
  }
}

export function createRelay(opts: RelayOptions): Relay {
  const { store } = opts;
  const limiter = opts.limiter ?? new Limiter();
  const log = opts.log ?? createLogger();
  const timing: Timing = { ...DEFAULT_TIMING, ...opts.timing };
  const now = opts.now ?? Date.now;
  const maxConnections = opts.maxConnections ?? 2000;
  const maxPerIp = opts.maxConnectionsPerIp ?? MAX_CONNECTIONS_PER_IP;
  const trustProxy = opts.trustProxy ?? false;
  const registry = new Registry();
  const heartbeat = new Heartbeat(timing, now);
  heartbeat.start();

  const server = http.createServer(handleHttp);
  const wssOpts = { noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false } as const;
  const wss = {
    host: new WebSocketServer(wssOpts),
    accept: new WebSocketServer(wssOpts),
    connect: new WebSocketServer(wssOpts),
  };
  let open = 0;
  const openPerIp = new Map<string, number>();
  const gc = (): void => {
    const removed = store.gc((route) => registry.host(route) !== undefined);
    if (removed > 0) log('routes_gc', { removed });
  };
  const gcTimer = setInterval(gc, GC_INTERVAL_MS);
  gcTimer.unref();

  /** Ждёт первый кадр; пришло что-то другое или время вышло — `bad_request`. */
  function firstFrame(ws: WebSocket, max: number, onFrame: (json: unknown) => void): void {
    const timer = setTimeout(() => fail(ws, 'bad_request'), timing.firstFrameMs);
    timer.unref();
    ws.once('close', () => clearTimeout(timer));
    ws.once('message', (data, isBinary) => {
      clearTimeout(timer);
      const json = parseControl(data, isBinary, max);
      if (json === undefined) return fail(ws, 'bad_request');
      onFrame(json);
    });
  }

  // ---------- /v1/host ----------
  function onHost(ws: WebSocket, ip: string): void {
    let host: Host | null = null;
    ws.on('close', () => {
      if (host && registry.host(host.routeId) === host) {
        registry.detach(host);
        // Отсчёт простоя маршрута для сборки мусора — с ухода моста, а не с его `hello`.
        store.touch(host.routeId);
        log('host_offline');
      }
    });

    const handle = (json: unknown): void => {
      // Вытесненный управляющий сокет ещё открыт, но говорить за маршрут больше не может (ревью A4, m6).
      if (host && registry.host(host.routeId) !== host) return;
      const parsed = hostFrame.safeParse(json);
      if (!parsed.success) return fail(ws, 'bad_request');
      const f = parsed.data;
      if (f.t === 'hello') {
        if (host) return fail(ws, 'bad_request');
        return hello(f.route, f.secret);
      }
      if (!host) return fail(ws, 'bad_request');
      if (f.t === 'devices') {
        store.replaceDevices(host.routeId, f.list);
        return;
      }
      // offer
      if (f.lookup === null) {
        registry.setOffer(host, null, 0);
        return;
      }
      const t = now();
      if (f.exp === undefined || f.exp <= t || f.exp > t + MAX_OFFER_MS) return fail(ws, 'bad_request');
      if (!registry.setOffer(host, f.lookup, f.exp)) return fail(ws, 'bad_request');
    };

    const hello = (route: string, secret: string): void => {
      const presented = sha256OfB64(secret);
      const rec = store.route(route);
      if (rec) {
        if (!hashMatches(rec.secretHash, presented)) return fail(ws, 'unknown_route');
        store.touch(route);
      } else {
        if (presented === null) return fail(ws, 'bad_request');
        if (store.routeCount() >= MAX_ROUTES) gc();
        if (store.routeCount() >= MAX_ROUTES || !limiter.hit('newRoute', ip)) return fail(ws, 'rate_limited');
        store.createRoute(route, b64urlEncode(presented));
        log('route_created');
      }
      host = registry.attach(route, ws);
      sendJson(ws, { v: 1, t: 'ok' });
      log('host_online');
    };

    // До `hello` — один кадр; после — любые управляющие кадры.
    firstFrame(ws, MAX_CONTROL_BYTES, (json) => {
      handle(json);
      ws.on('message', (data, isBinary) => {
        const next = parseControl(data, isBinary, MAX_CONTROL_BYTES);
        if (next === undefined) return fail(ws, 'bad_request');
        handle(next);
      });
    });
  }

  // ---------- /v1/connect ----------
  function onConnect(ws: WebSocket, ip: string): void {
    firstFrame(ws, 1024, (json) => {
      const c = connectFrame.safeParse(json);
      if (c.success) {
        if (!limiter.hit('connect', ip)) return fail(ws, 'rate_limited');
        const { route, device, token } = c.data;
        if (!store.route(route)) return fail(ws, 'unknown_route');
        if (!hashMatches(store.deviceHash(route, device), sha256OfB64(token))) return fail(ws, 'unknown_device');
        const host = registry.host(route);
        if (!host) return fail(ws, 'host_offline');
        return enqueue(ws, host, 'connect', device);
      }
      const p = pairFrame.safeParse(json);
      if (p.success) {
        if (!limiter.hit('pair', ip)) return fail(ws, 'rate_limited');
        const host = registry.findOffer(p.data.lookup, now());
        if (!host) return fail(ws, 'offer_closed');
        return enqueue(ws, host, 'pair');
      }
      // Нераспознанный кадр тоже тратит лимит connect: бесплатного перебора нет.
      if (!limiter.hit('connect', ip)) return fail(ws, 'rate_limited');
      fail(ws, 'bad_request');
    });
  }

  /** Ставит телефон в ожидание `accept` и сообщает мосту. */
  function enqueue(phone: WebSocket, host: Host, kind: 'connect' | 'pair', device?: string): void {
    if (registry.streams(host.routeId) >= MAX_STREAMS_PER_ROUTE) return fail(phone, 'rate_limited');
    const stream = b64urlEncode(randomBytes(12));
    const timer = setTimeout(() => {
      if (host.pending.delete(stream)) fail(phone, 'host_offline');
    }, timing.acceptWaitMs);
    timer.unref();
    // Телефон не должен слать ничего, пока не получил `ready`.
    const stray = (): void => {
      if (host.pending.delete(stream)) {
        clearTimeout(timer);
        closeSoft(phone, 1008);
      }
    };
    const gone = (): void => {
      if (host.pending.delete(stream)) clearTimeout(timer);
    };
    const release = (): void => {
      phone.off('message', stray);
      phone.off('close', gone);
    };
    host.pending.set(stream, { phone, timer, release });
    phone.on('message', stray);
    phone.on('close', gone);
    sendJson(host.ws, device === undefined ? { v: 1, t: 'incoming', stream, kind } : { v: 1, t: 'incoming', stream, kind, device });
  }

  // ---------- /v1/accept ----------
  function onAccept(ws: WebSocket): void {
    firstFrame(ws, 1024, (json) => {
      const a = acceptFrame.safeParse(json);
      if (!a.success) return fail(ws, 'bad_request');
      const rec = store.route(a.data.route);
      if (!rec || !hashMatches(rec.secretHash, sha256OfB64(a.data.secret))) return fail(ws, 'unknown_route');
      const host = registry.host(a.data.route);
      const pending = host?.pending.get(a.data.stream);
      if (!host || !pending) return fail(ws, 'bad_request');
      host.pending.delete(a.data.stream);
      clearTimeout(pending.timer);
      const phone = pending.phone;
      pending.release();
      if (phone.readyState !== WebSocket.OPEN) return closeSoft(ws);
      registry.pipeOpened(host.routeId);
      splice(phone, ws, {
        maxLifeMs: timing.pipeMaxMs,
        onClose: () => {
          registry.pipeClosed(host.routeId);
          log('pipe_close');
        },
      });
      log('pipe_open');
      sendJson(phone, { v: 1, t: 'ready' });
    });
  }

  // ---------- upgrade ----------
  server.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '').split('?')[0];
    const kind = path === '/v1/host' ? 'host' : path === '/v1/accept' ? 'accept' : path === '/v1/connect' ? 'connect' : null;
    if (kind === null) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    if (open >= maxConnections) {
      log('rejected', { reason: 'max_connections' });
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      return;
    }
    const ip = clientIp(req, trustProxy);
    const fromIp = openPerIp.get(ip) ?? 0;
    if (fromIp >= maxPerIp) {
      log('rejected', { reason: 'max_per_ip' });
      socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
      return;
    }
    // Счёт — до upgrade и по TCP-сокету: параллельные upgrade не проскакивают сверх пределов, а сорванный
    // upgrade всё равно освобождает место.
    open++;
    openPerIp.set(ip, fromIp + 1);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      open--;
      const n = (openPerIp.get(ip) ?? 1) - 1;
      if (n > 0) openPerIp.set(ip, n);
      else openPerIp.delete(ip);
    };
    socket.once('close', release);
    wss[kind].handleUpgrade(req, socket, head, (ws) => {
      ws.on('close', release);
      ws.on('error', () => {});
      heartbeat.add(ws);
      if (kind === 'host') onHost(ws, ip);
      else if (kind === 'accept') onAccept(ws);
      else onConnect(ws, ip);
    });
  });

  return {
    server,
    registry,
    heartbeat,
    close: () =>
      new Promise<void>((resolve) => {
        heartbeat.stop();
        clearInterval(gcTimer);
        store.flush();
        for (const w of Object.values(wss)) for (const c of w.clients) c.terminate();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
