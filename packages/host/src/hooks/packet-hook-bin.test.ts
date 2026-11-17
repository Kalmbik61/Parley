/**
 * Мост пакета состояния комнаты: на `startup`/`resume` ни одного запроса; на `compact` — печатает ответ хоста; опоздавший ответ,
 * статус не 200, закрытое соединение и пустой ответ — пустота; код выхода всегда 0 (процесс моста запускается отдельно).
 * Хост — подставной сервер на `node:http`.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PACKET_BRIDGE_EVENT } from '@parley/core';
import { appendDetached, BRIDGE_WAIT_MS, finish, JOURNAL_GRACE_MS, runPacketBridge, type BridgeDeps } from './packet-hook-bin.js';

const COMPACT = JSON.stringify({ hook_event_name: 'SessionStart', source: 'compact', session_id: 'c-1' });
const PACKET = 'Room state packet abc123 …';
const WITH_PACKET = JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: PACKET } });

let dir = '';
let server: Server | null = null;
let requests: { method?: string; headers: IncomingMessage['headers']; body: string }[] = [];
let handler: (req: IncomingMessage, res: ServerResponse) => void = () => {};

const url = (): string => `http://127.0.0.1:${(server!.address() as AddressInfo).port}/hooks/packet`;
const env = (): NodeJS.ProcessEnv => ({
  PARLEY_SESSION_ID: 's-02',
  PARLEY_WORK_DIR: dir,
  PARLEY_HOOK_TOKEN: 'tok-1',
});
/** Вывод моста после того, как записана и его запись в журнал (как если бы процесс дождался её). */
const bridge = async (input: string, args: readonly string[], environment: NodeJS.ProcessEnv, deps: BridgeDeps = {}): Promise<string> => {
  // Запись — в этом же процессе: тест читает журнал сразу. Отдельный процесс-писатель проверяется ниже.
  const result = await runPacketBridge(input, args, environment, { append: (file, text) => appendFile(file, text, 'utf8'), ...deps });
  await result.journal();
  return result.out;
};
const journal = async (): Promise<Record<string, unknown>[]> =>
  (await readFile(path.join(dir, 'events', 's-02.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'parley-packet-bridge-'));
  await mkdir(path.join(dir, 'events'), { recursive: true });
  requests = [];
  handler = (_req, res) => res.writeHead(200).end(WITH_PACKET);
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({ method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      handler(req, res);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
});

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

describe('мост: не сжатие — выход сразу', () => {
  it('startup, resume, clear, другое событие, мусор вместо JSON: пусто, ни одного запроса, записи моста нет', async () => {
    for (const input of [
      JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' }),
      JSON.stringify({ hook_event_name: 'SessionStart', source: 'resume' }),
      JSON.stringify({ hook_event_name: 'SessionStart', source: 'clear' }),
      JSON.stringify({ hook_event_name: 'SessionStart' }),
      JSON.stringify({ hook_event_name: 'UserPromptSubmit', source: 'compact' }),
      'not json',
      '',
    ]) {
      expect(await bridge(input, [url(), 'PARLEY_HOOK_TOKEN'], env())).toBe('');
    }
    expect(requests).toEqual([]);
    expect(await journal()).toEqual([]);
  });
});

describe('мост: сжатие', () => {
  it('печатает ответ хоста целиком в форме additionalContext; запрос несёт токен и сессию, тело — вход события; запись printed', async () => {
    const out = await bridge(COMPACT, [url(), 'PARLEY_HOOK_TOKEN'], env());
    expect(JSON.parse(out)).toEqual({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: PACKET } });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.headers['authorization']).toBe('Bearer tok-1');
    expect(requests[0]?.headers['x-parley-session']).toBe('s-02');
    expect(requests[0]?.body).toBe(COMPACT);
    const records = await journal();
    expect(records).toEqual([{ hook_event_name: PACKET_BRIDGE_EVENT, outcome: 'printed', requestMs: expect.any(Number) }]);
  });

  it('имя события записи моста совпадает с именем из core', () => {
    expect(PACKET_BRIDGE_EVENT).toBe('ParleyRoomPacketBridge');
  });

  it('пустой ответ хоста ({} и без additionalContext), не JSON, пустая строка — пустота, исход empty', async () => {
    for (const body of ['{}', 'oops', JSON.stringify({ hookSpecificOutput: { additionalContext: '' } }), JSON.stringify({ hookSpecificOutput: { additionalContext: 5 } })]) {
      handler = (_req, res) => res.writeHead(200).end(body);
      expect(await bridge(COMPACT, [url(), 'PARLEY_HOOK_TOKEN'], env())).toBe('');
    }
    expect((await journal()).map((record) => record['outcome'])).toEqual(['empty', 'empty', 'empty', 'empty']);
  });

  it('статус не 200 — пустота, исход refused', async () => {
    for (const status of [401, 404, 413, 500]) {
      handler = (_req, res) => res.writeHead(status).end(WITH_PACKET);
      expect(await bridge(COMPACT, [url(), 'PARLEY_HOOK_TOKEN'], env())).toBe('');
    }
    expect((await journal()).map((record) => record['outcome'])).toEqual(['refused', 'refused', 'refused', 'refused']);
  });

  it('закрытое соединение — пустота, исход unreachable', async () => {
    handler = (req) => req.socket.destroy();
    expect(await bridge(COMPACT, [url(), 'PARLEY_HOOK_TOKEN'], env())).toBe('');
    expect((await journal())[0]?.['outcome']).toBe('unreachable');
  });

  it('хост недоступен (порт закрыт) — пустота, исход unreachable, запись моста всё равно есть', async () => {
    const dead = url();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = createServer();
    expect(await bridge(COMPACT, [dead, 'PARLEY_HOOK_TOKEN'], env())).toBe('');
    expect(await journal()).toEqual([{ hook_event_name: PACKET_BRIDGE_EVENT, outcome: 'unreachable', requestMs: expect.any(Number) }]);
  });

  it('ответ позже предела — пустота в срок, исход timeout; предел 1,5 с', async () => {
    expect(BRIDGE_WAIT_MS).toBe(1500);
    handler = () => {};
    const startedAt = Date.now();
    expect(await bridge(COMPACT, [url(), 'PARLEY_HOOK_TOKEN'], env(), { waitMs: 150 })).toBe('');
    expect(Date.now() - startedAt).toBeLessThan(1000);
    const [record] = await journal();
    expect(record?.['outcome']).toBe('timeout');
    expect(record?.['requestMs']).toBeGreaterThanOrEqual(100);
  });

  it('нет токена, адреса или сессии — пустота без запроса, исход unreachable', async () => {
    expect(await bridge(COMPACT, [url(), 'PARLEY_HOOK_TOKEN'], { ...env(), PARLEY_HOOK_TOKEN: undefined })).toBe('');
    expect(await bridge(COMPACT, [], env())).toBe('');
    expect(await bridge(COMPACT, [url(), 'PARLEY_HOOK_TOKEN'], { ...env(), PARLEY_SESSION_ID: undefined })).toBe('');
    expect(requests).toEqual([]);
  });

  it('прежние имена окружения HARNAS_* понимаются; токен берётся из переменной, имя которой пришло аргументом', async () => {
    const legacy = { HARNAS_SESSION_ID: 's-02', HARNAS_WORK_DIR: dir, PARLEY_HOOK_CAPABILITY: 'cap-9' };
    expect(await bridge(COMPACT, [url(), 'PARLEY_HOOK_CAPABILITY'], legacy)).not.toBe('');
    expect(requests[0]?.headers['authorization']).toBe('Bearer cap-9');
    expect((await journal())[0]?.['outcome']).toBe('printed');
  });

  it('сбой записи в журнал не меняет вывод', async () => {
    const out = await bridge(COMPACT, [url(), 'PARLEY_HOOK_TOKEN'], env(), { append: async () => { throw new Error('read-only'); } });
    expect(JSON.parse(out).hookSpecificOutput.additionalContext).toBe(PACKET);
  });

  it('каталога events/ нет — запись не создаёт его, вывод прежний', async () => {
    await rm(path.join(dir, 'events'), { recursive: true });
    expect(await bridge(COMPACT, [url(), 'PARLEY_HOOK_TOKEN'], env())).not.toBe('');
    expect(await journal()).toEqual([]);
  });
});

describe('мост: ответ печатается раньше записи журнала, ожидание записи ограничено', () => {
  const never = (): Promise<void> => new Promise<void>(() => {});

  it('запись, которая не завершается: вывод готов сразу, requestMs взят до записи, finish возвращается за льготу', async () => {
    let appended = 0;
    let line = '';
    const startedAt = Date.now();
    const result = await runPacketBridge(COMPACT, [url(), 'PARLEY_HOOK_TOKEN'], env(), { append: (_file, text) => { appended += 1; line = text; return never(); } });
    // Результат вернулся, запись ещё не начата: вывод её не ждёт, а запускает её только вызывающий после вывода.
    expect(JSON.parse(result.out).hookSpecificOutput.additionalContext).toBe(PACKET);
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(appended).toBe(0);

    const printedAt: number[] = [];
    const finishing = Date.now();
    await finish(result, (out, done) => { printedAt.push(Date.now()); expect(out).toBe(result.out); done(); }, 120);
    expect(printedAt).toHaveLength(1);
    expect(appended).toBe(1);
    const record = JSON.parse(line) as { requestMs: number; ms?: number };
    expect(record.requestMs).toBeLessThan(1000);
    expect(record).not.toHaveProperty('ms');
    // Вывод — до ожидания записи, выход — не позже льготы (с запасом на планировщик).
    expect(printedAt[0]! - finishing).toBeLessThan(100);
    expect(Date.now() - finishing).toBeGreaterThanOrEqual(110);
    expect(Date.now() - finishing).toBeLessThan(1000);
  });

  it('порядок: вывод записан раньше, чем начата запись журнала, включая запуск писателя', async () => {
    const events: string[] = [];
    const result = await runPacketBridge(COMPACT, [url(), 'PARLEY_HOOK_TOKEN'], env(), {
      append: async () => { events.push('journal-started'); },
    });
    expect(events).toEqual([]);
    // Вывод записывается не мгновенно: запись журнала не должна начаться, пока он не записан.
    await finish(result, (out, done) => {
      events.push('print-begun');
      setTimeout(() => { events.push('printed'); expect(out).not.toBe(''); done(); }, 60);
    }, 200);
    expect(events).toEqual(['print-begun', 'printed', 'journal-started']);
  });

  it('собранный процесс: ответ напечатан, код 0, строка журнала дописана отдельным писателем уже после выхода моста', async () => {
    const built = fileURLToPath(new URL('../../dist/hooks/packet-hook-bin.js', import.meta.url));
    if (!existsSync(built)) return;
    const child = spawn(process.execPath, [built, url(), 'PARLEY_HOOK_TOKEN'], { env: { ...env(), PATH: process.env['PATH'] } });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stdin.end(COMPACT);
    const status = await new Promise((resolve) => child.on('close', resolve));
    expect(status).toBe(0);
    expect(JSON.parse(stdout).hookSpecificOutput.additionalContext).toBe(PACKET);
    await vi.waitFor(async () => expect((await journal())[0]?.['outcome']).toBe('printed'), { timeout: 3000 });
  });

  it('запись, которая завершается медленно (в пределах льготы): finish ждёт её и не дольше, вывод тот же', async () => {
    let written = false;
    const result = await runPacketBridge(COMPACT, [url(), 'PARLEY_HOOK_TOKEN'], env(), {
      append: async () => { await new Promise((resolve) => setTimeout(resolve, 80)); written = true; },
    });
    expect(written).toBe(false);
    const begun = Date.now();
    await finish(result, (_out, done) => done(), 500);
    expect(written).toBe(true);
    expect(Date.now() - begun).toBeLessThan(400);
    expect(JSON.parse(result.out).hookSpecificOutput.additionalContext).toBe(PACKET);
  });

  it('запись, которая медленнее льготы: finish не ждёт её дольше льготы', async () => {
    let written = false;
    const result = await runPacketBridge(COMPACT, [url(), 'PARLEY_HOOK_TOKEN'], env(), {
      append: async () => { await new Promise((resolve) => setTimeout(resolve, 600)); written = true; },
    });
    const begun = Date.now();
    await finish(result, (_out, done) => done(), 100);
    expect(written).toBe(false);
    expect(Date.now() - begun).toBeLessThan(400);
  });

  it('писатель по умолчанию — отдельный процесс: строка в журнале появляется, вызывающий не ждёт записи', async () => {
    const file = path.join(dir, 'events', 's-02.jsonl');
    await appendDetached(file, 'one\n');
    await vi.waitFor(async () => expect(await readFile(file, 'utf8')).toBe('one\n'), { timeout: 3000 });
    // Каталога нет — писатель его не создаёт и молча уходит.
    await expect(appendDetached(path.join(dir, 'missing', 'x.jsonl'), 'two\n')).resolves.toBeUndefined();
  });

  it('JOURNAL_GRACE_MS меньше запаса предела хука: ожидание хоста и льгота вместе укладываются в 2 с', () => {
    expect(BRIDGE_WAIT_MS + JOURNAL_GRACE_MS).toBeLessThan(2000);
  });
});

describe('мост как процесс', () => {
  // Собранный мост лежит в dist (его делает `pnpm build`); процесс проверяет то, чего вызов функции не покажет: код выхода и stdout.
  const built = fileURLToPath(new URL('../../dist/hooks/packet-hook-bin.js', import.meta.url));

  const run = (input: string, args: string[]): Promise<{ status: number | null; stdout: string }> =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [built, ...args], { env: { ...env(), PATH: process.env['PATH'] } });
      let stdout = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, stdout }));
      child.stdin.end(input);
    });

  it.skipIf(!existsSync(built))('код выхода 0 и пустой stdout на startup, мусоре и недоступном хосте; на compact — вывод хоста', async () => {
    expect(await run(JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' }), [url(), 'PARLEY_HOOK_TOKEN'])).toEqual({ status: 0, stdout: '' });
    expect(requests).toEqual([]);
    expect(await run('garbage', [])).toEqual({ status: 0, stdout: '' });
    expect(await run(COMPACT, ['http://127.0.0.1:1/hooks/packet', 'PARLEY_HOOK_TOKEN'])).toEqual({ status: 0, stdout: '' });
    const printed = await run(COMPACT, [url(), 'PARLEY_HOOK_TOKEN']);
    expect(printed.status).toBe(0);
    expect(JSON.parse(printed.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: PACKET } });
    handler = (_req, res) => res.writeHead(500).end();
    expect(await run(COMPACT, [url(), 'PARLEY_HOOK_TOKEN'])).toEqual({ status: 0, stdout: '' });
  });

  it.skipIf(!existsSync(built) || process.platform === 'win32')('журнал сессии — именованный канал без читателя (запись зависает насовсем): вывод есть, код 0, процесс уходит быстро', async () => {
    const fifo = path.join(dir, 'events', 's-02.jsonl');
    execFileSync('mkfifo', [fifo]);
    const startedAt = Date.now();
    const printed = await run(COMPACT, [url(), 'PARLEY_HOOK_TOKEN']);
    expect(printed.status).toBe(0);
    expect(JSON.parse(printed.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: PACKET } });
    expect(Date.now() - startedAt).toBeLessThan(2000);
    // Пустой исход при зависшей записи — тоже код 0 и пустой вывод.
    handler = (_req, res) => res.writeHead(500).end();
    expect(await run(COMPACT, [url(), 'PARLEY_HOOK_TOKEN'])).toEqual({ status: 0, stdout: '' });
  });
});
