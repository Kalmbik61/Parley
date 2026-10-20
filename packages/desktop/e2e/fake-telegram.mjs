import { Buffer } from 'node:buffer';
import http from 'node:http';
import { clearTimeout, setTimeout } from 'node:timers';

/**
 * Фейковый Telegram Bot API для E2E канала Telegram (план B, задача 14).
 * Сервер слушает 127.0.0.1 на свободном порту; хост приложения ходит в него вместо api.telegram.org через
 * `PARLEY_TELEGRAM_API=<url>`. Маршруты — `POST /bot<token>/<method>` с JSON-телом, ответ — `{ ok, result }`.
 * `getUpdates` — long poll: отвечает сразу, если в очереди есть апдейты, иначе ждёт `timeout` секунд (но не дольше 25)
 * или появления апдейта через `push`. Остальные методы отвечают сразу; всё, что пришло, пишется в журнал запросов.
 *
 * Возвращает `{ url, push(update), sent(), requests(), close() }`:
 * - `push(update)` кладёт апдейт в очередь и будит ожидающий `getUpdates`;
 * - `sent()` — журнал `sendMessage`/`editMessageText` (метод, chat_id, text, message_id);
 * - `requests()` — журнал всех вызовов Bot API (метод, тело, момент в мс), по нему проверяют, что опрос прекратился;
 * - `close()` закрывает сервер и обрывает висящие соединения.
 */

const MAX_POLL_SECONDS = 25;
const BOT = { id: 123456, is_bot: true, username: 'parley_fake_bot' };

/** Методы, на которые бот отвечает сообщением (с растущим `message_id`). */
const MESSAGE_METHODS = new Set(['sendMessage', 'editMessageText']);

export async function startFakeTelegram() {
  /** @type {Array<Record<string, unknown>>} */
  const queue = [];
  /** Ожидающие `getUpdates`: `wake()` отвечает на них, как только в очереди что-то появилось. */
  /** @type {Set<() => void>} */
  const waiters = new Set();
  /** @type {Array<{ method: string; body: Record<string, unknown>; at: number }>} */
  const log = [];
  /** @type {Set<import('node:net').Socket>} */
  const sockets = new Set();
  let nextMessageId = 100;

  const reply = (res, result) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result }));
  };

  /** Выдаёт всю очередь разом: хост сам подтверждает прочитанное через `offset`, поэтому повторно не отдаём. */
  const drain = () => queue.splice(0, queue.length);

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const match = /^\/bot[^/]+\/(\w+)$/.exec(req.url ?? '');
      if (req.method !== 'POST' || match === null) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error_code: 404, description: 'Not Found' }));
        return;
      }
      const method = match[1];
      const raw = Buffer.concat(chunks).toString('utf8');
      /** @type {Record<string, unknown>} */
      let body = {};
      try {
        body = raw === '' ? {} : JSON.parse(raw);
      } catch {
        // Не JSON (например, multipart с файлом) — тело в журнале останется пустым.
      }
      log.push({ method, body, at: Date.now() });

      if (method === 'getMe') return reply(res, BOT);
      if (method === 'getUpdates') {
        if (queue.length > 0) return reply(res, drain());
        const seconds = Math.min(Number(body.timeout ?? 0) || 0, MAX_POLL_SECONDS);
        let timer = null;
        const finish = () => {
          if (timer !== null) clearTimeout(timer);
          waiters.delete(finish);
          if (res.writableEnded || res.destroyed) return;
          reply(res, drain());
        };
        timer = setTimeout(finish, seconds * 1000);
        waiters.add(finish);
        // Хост оборвал запрос (остановил опрос): ждать дальше нечего.
        res.on('close', () => {
          if (timer !== null) clearTimeout(timer);
          waiters.delete(finish);
        });
        return;
      }
      if (MESSAGE_METHODS.has(method)) {
        nextMessageId += 1;
        return reply(res, {
          message_id: nextMessageId,
          date: Math.floor(Date.now() / 1000),
          chat: { id: Number(body.chat_id ?? 777), type: 'private' },
          from: BOT,
          text: typeof body.text === 'string' ? body.text : '',
        });
      }
      return reply(res, true);
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(undefined));
  });
  const address = server.address();
  const url = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;

  return {
    url,
    push(update) {
      queue.push(update);
      for (const wake of [...waiters]) wake();
    },
    sent() {
      return log
        .filter((entry) => MESSAGE_METHODS.has(entry.method))
        .map((entry) => ({
          method: entry.method,
          chatId: Number(entry.body.chat_id ?? 0),
          text: typeof entry.body.text === 'string' ? entry.body.text : '',
          messageId: entry.body.message_id ?? null,
        }));
    },
    requests() {
      return log.map((entry) => ({ method: entry.method, body: entry.body, at: entry.at }));
    },
    async close() {
      for (const wake of [...waiters]) wake();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}
