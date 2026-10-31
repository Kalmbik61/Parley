import type http from 'node:http';

/** `GET /v1/health` → 200; любой другой HTTP-запрос — 404. Тело не содержит состояния. */
export function handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
  const path = (req.url ?? '').split('?')[0];
  const ok = req.method === 'GET' && path === '/v1/health';
  const body = ok ? '{"ok":true}' : '{"error":"not_found"}';
  res.writeHead(ok ? 200 : 404, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}
