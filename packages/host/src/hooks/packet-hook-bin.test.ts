/**
 * Мост пакета состояния комнаты: на `startup`/`resume` ни одного запроса; на `compact` — печатает ответ хоста; опоздавший ответ,
 * статус не 200, закрытое соединение и пустой ответ — пустота; код выхода всегда 0 (процесс моста запускается отдельно).
 * Хост — подставной сервер на `node:http`.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PACKET_BRIDGE_EVENT } from '@parley/core';
import { BRIDGE_WAIT_MS, runPacketBridge } from './packet-hook-bin.js';

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
      expect(await runPacketBridge(input, [url(), 'PARLEY_HOOK_TOKEN'], env())).toBe('');
    }
    expect(requests).toEqual([]);
    expect(await journal()).toEqual([]);
  });
});

describe('мост: сжатие', () => {
  it('печатает ответ хоста целиком в форме additionalContext; запрос несёт токен и сессию, тело — вход события; запись printed', async () => {
    const out = await runPacketBridge(COMPACT, [url(), 'PARLEY_HOOK_TOKEN'], env());
    expect(JSON.parse(out)).toEqual({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: PACKET } });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.headers['authorization']).toBe('Bearer tok-1');
    expect(requests[0]?.headers['x-parley-session']).toBe('s-02');
    expect(requests[0]?.body).toBe(COMPACT);
    const records = await journal();
    expect(records).toEqual([{ hook_event_name: PACKET_BRIDGE_EVENT, outcome: 'printed', ms: expect.any(Number) }]);
  });

  it('имя события записи моста совпадает с именем из core', () => {
    expect(PACKET_BRIDGE_EVENT).toBe('ParleyRoomPacketBridge');
  });

  it('пустой ответ хоста ({} и без additionalContext), не JSON, пустая строка — пустота, исход empty', async () => {
    for (const body of ['{}', 'oops', JSON.stringify({ hookSpecificOutput: { additionalContext: '' } }), JSON.stringify({ hookSpecificOutput: { additionalContext: 5 } })]) {
      handler = (_req, res) => res.writeHead(200).end(body);
      expect(await runPacketBridge(COMPACT, [url(), 'PARLEY_HOOK_TOKEN'], env())).toBe('');
    }
    expect((await journal()).map((record) => record['outcome'])).toEqual(['empty', 'empty', 'empty', 'empty']);
  });

  it('статус не 200 — пустота, исход refused', async () => {
    for (const status of [401, 404, 413, 500]) {
      handler = (_req, res) => res.writeHead(status).end(WITH_PACKET);
      expect(await runPacketBridge(COMPACT, [url(), 'PARLEY_HOOK_TOKEN'], env())).toBe('');
    }
    expect((await journal()).map((record) => record['outcome'])).toEqual(['refused', 'refused', 'refused', 'refused']);
  });

  it('закрытое соединение — пустота, исход unreachable', async () => {
    handler = (req) => req.socket.destroy();
    expect(await runPacketBridge(COMPACT, [url(), 'PARLEY_HOOK_TOKEN'], env())).toBe('');
    expect((await journal())[0]?.['outcome']).toBe('unreachable');
  });

  it('хост недоступен (порт закрыт) — пустота, исход unreachable, запись моста всё равно есть', async () => {
    const dead = url();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = createServer();
    expect(await runPacketBridge(COMPACT, [dead, 'PARLEY_HOOK_TOKEN'], env())).toBe('');
    expect(await journal()).toEqual([{ hook_event_name: PACKET_BRIDGE_EVENT, outcome: 'unreachable', ms: expect.any(Number) }]);
  });

  it('ответ позже предела — пустота в срок, исход timeout; предел 1,5 с', async () => {
    expect(BRIDGE_WAIT_MS).toBe(1500);
    handler = () => {};
    const startedAt = Date.now();
    expect(await runPacketBridge(COMPACT, [url(), 'PARLEY_HOOK_TOKEN'], env(), { waitMs: 150 })).toBe('');
    expect(Date.now() - startedAt).toBeLessThan(1000);
    const [record] = await journal();
    expect(record?.['outcome']).toBe('timeout');
    expect(record?.['ms']).toBeGreaterThanOrEqual(100);
  });

  it('нет токена, адреса или сессии — пустота без запроса, исход unreachable', async () => {
    expect(await runPacketBridge(COMPACT, [url(), 'PARLEY_HOOK_TOKEN'], { ...env(), PARLEY_HOOK_TOKEN: undefined })).toBe('');
    expect(await runPacketBridge(COMPACT, [], env())).toBe('');
    expect(await runPacketBridge(COMPACT, [url(), 'PARLEY_HOOK_TOKEN'], { ...env(), PARLEY_SESSION_ID: undefined })).toBe('');
    expect(requests).toEqual([]);
  });

  it('прежние имена окружения HARNAS_* понимаются; токен берётся из переменной, имя которой пришло аргументом', async () => {
    const legacy = { HARNAS_SESSION_ID: 's-02', HARNAS_WORK_DIR: dir, PARLEY_HOOK_CAPABILITY: 'cap-9' };
    expect(await runPacketBridge(COMPACT, [url(), 'PARLEY_HOOK_CAPABILITY'], legacy)).not.toBe('');
    expect(requests[0]?.headers['authorization']).toBe('Bearer cap-9');
    expect((await journal())[0]?.['outcome']).toBe('printed');
  });

  it('сбой записи в журнал не меняет вывод', async () => {
    const out = await runPacketBridge(COMPACT, [url(), 'PARLEY_HOOK_TOKEN'], env(), { append: async () => { throw new Error('read-only'); } });
    expect(JSON.parse(out).hookSpecificOutput.additionalContext).toBe(PACKET);
  });

  it('каталога events/ нет — запись не создаёт его, вывод прежний', async () => {
    await rm(path.join(dir, 'events'), { recursive: true });
    expect(await runPacketBridge(COMPACT, [url(), 'PARLEY_HOOK_TOKEN'], env())).not.toBe('');
    expect(await journal()).toEqual([]);
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
});
