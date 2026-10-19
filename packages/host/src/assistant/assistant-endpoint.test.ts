import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { silentLog } from '../../test/feed-fakes.js';
import { ASSISTANT_BODY_LIMIT, ASSISTANT_PATH, ASSISTANT_TOOL_NAMES, createAssistantEndpoint, type AssistantReply } from './assistant-endpoint.js';

let servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  servers = [];
});

/** Обработчик инструмента по умолчанию — `200 {text:'ok'}`; тесты переопределяют через `mock*Once`. */
const okTool = () => vi.fn(async (): Promise<AssistantReply> => ({ status: 200, body: { text: 'ok' } }));

/** Сервер с маршрутами приёмника — как их подключает сервер хуков: только точный путь, остальное — 404. */
async function boot(tool = okTool()) {
  const endpoint = createAssistantEndpoint({ log: silentLog(), tool });
  const routes = endpoint.routes();
  const server = createServer((req, res) => {
    const route = routes[(req.url ?? '').split('?')[0] ?? ''];
    if (route === undefined) {
      res.writeHead(404).end();
      return;
    }
    route(req, res);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (name: string, token: string | null, body = '{"a":1}'): Promise<Response> =>
    fetch(`${origin}${ASSISTANT_PATH}/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token === null ? {} : { authorization: `Bearer ${token}` }) },
      body,
    });
  return { endpoint, tool, post, origin };
}

describe('приёмник инструментов помощника (спека 2026-10-14, 7.1)', () => {
  it('маршрут на каждый инструмент, и только на них', async () => {
    const { endpoint, post } = await boot();
    expect(Object.keys(endpoint.routes()).sort()).toEqual([...ASSISTANT_TOOL_NAMES].map((name) => `${ASSISTANT_PATH}/${name}`).sort());
    endpoint.setToken('t');
    expect((await post('unknown_tool', 't')).status).toBe(404);
  });

  it('верный токен — ответ обработчика; без токена, чужой или снятый — 401 без тела', async () => {
    const { endpoint, tool, post } = await boot();
    expect((await post('parley_overview', 'nope')).status).toBe(401);
    expect((await post('parley_overview', null)).status).toBe(401);
    endpoint.setToken('secret-1');
    const ok = await post('parley_overview', 'secret-1');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ text: 'ok' });
    expect(tool).toHaveBeenCalledWith('parley_overview', { a: 1 });
    expect((await post('parley_overview', 'secret-2')).status).toBe(401);
    endpoint.setToken(null);
    expect((await post('parley_overview', 'secret-1')).status).toBe(401);
    expect(tool).toHaveBeenCalledTimes(1);
  });

  it('propose_room и propose_room_decision доходят до обработчика под своими именами', async () => {
    const tool = okTool();
    const { endpoint, post } = await boot(tool);
    endpoint.setToken('t');
    expect((await post('propose_room', 't')).status).toBe(200);
    expect((await post('propose_room_decision', 't')).status).toBe(200);
    expect(tool).toHaveBeenNthCalledWith(1, 'propose_room', { a: 1 });
    expect(tool).toHaveBeenNthCalledWith(2, 'propose_room_decision', { a: 1 });
  });

  it('статус и тело обработчика уходят как есть; исключение — 500 с текстом', async () => {
    const tool = okTool();
    tool.mockResolvedValueOnce({ status: 409, body: { error: 'busy' } }).mockRejectedValueOnce(new Error('boom'));
    const { endpoint, post } = await boot(tool);
    endpoint.setToken('t');
    const conflict = await post('propose_message', 't');
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: 'busy' });
    const failed = await post('propose_message', 't');
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: 'boom' });
  });

  it('пустое тело — пустые аргументы; битый JSON или не объект — 400', async () => {
    const { endpoint, tool, post } = await boot();
    endpoint.setToken('t');
    expect((await post('parley_detail', 't', '')).status).toBe(200);
    expect(tool).toHaveBeenLastCalledWith('parley_detail', {});
    expect((await post('parley_detail', 't', '{')).status).toBe(400);
    expect((await post('parley_detail', 't', '[1]')).status).toBe(400);
    expect(tool).toHaveBeenCalledTimes(1);
  });

  it('тело больше предела — 413 (образец — тест 413 в hooks/hook-server.test.ts)', async () => {
    const { endpoint, tool, origin } = await boot();
    endpoint.setToken('t');
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${origin}${ASSISTANT_PATH}/parley_detail`, { method: 'POST', headers: { authorization: 'Bearer t', 'content-type': 'application/json' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', (error: NodeJS.ErrnoException) => {
        // Сервер закрыл соединение, не дочитав тело, — это и есть отказ.
        if (error.code === 'EPIPE' || error.code === 'ECONNRESET') resolve(413);
        else reject(error);
      });
      req.end(`{"text":"${'x'.repeat(ASSISTANT_BODY_LIMIT)}"}`);
    });
    expect(status).toBe(413);
    expect(tool).not.toHaveBeenCalled();
  });
});
