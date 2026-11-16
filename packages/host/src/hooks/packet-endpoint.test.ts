/**
 * Путь пакета состояния комнаты (`packet-endpoint`) на настоящем приёмнике хуков, настоящей регистрации токенов и настоящем
 * хранилище работы во временной папке. Главное место — доступ: сессию называет регистрация токена, а не запрос; отказ не
 * отдаёт текста пакета и не пишет в журнал сессии.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CONFIG, ROOM_PACKET_EVENT, addRoom, addSession, createWork, sessionRoomPacket, updateMap, workPaths, type McpContext,
} from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import { silentLog } from '../../test/feed-fakes.js';
import { createHookServer, type HookServer } from './hook-server.js';
import { createPacketEndpoint, PACKET_FAULT_ENV, PACKET_PATH, parsePacketFault, type PacketEndpointDeps } from './packet-endpoint.js';

let home = '';
let project = '';
let workId = '';
let server: HookServer | null = null;

const refOf = (sessionId: string): SessionRef => ({ projectPath: project, workId, sessionId });
const contextOf = (ref: SessionRef): McpContext => ({
  projectPath: ref.projectPath,
  workId: ref.workId,
  workDir: workPaths(ref.projectPath, ref.workId).dir,
  sessionId: ref.sessionId,
  channel: false,
  messageRate: DEFAULT_CONFIG.messageRate,
});

const COMPACT = { hook_event_name: 'SessionStart', source: 'compact', session_id: 'c-1' };

interface Reply { status: number; body: string }

function post(url: string, body: unknown, options: { token?: string | null; session?: string | null } = {}): Promise<Reply> {
  const target = new URL(url);
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
      agent: false,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(payload)),
        ...(options.token === null || options.token === undefined ? {} : { Authorization: `Bearer ${options.token}` }),
        ...(options.session === null || options.session === undefined ? {} : { 'X-Parley-Session': options.session }),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function boot(over: Partial<PacketEndpointDeps> = {}, bodyLimit?: number) {
  const endpoint = createPacketEndpoint({
    log: silentLog(),
    enabled: async () => true,
    context: async (ref) => contextOf(ref),
    fault: () => undefined,
    ...over,
  });
  server = createHookServer({
    log: silentLog(),
    onHook: () => { throw new Error('the packet path must not feed the hook chain'); },
    guarded: { [PACKET_PATH]: (request) => endpoint.handle(request) },
    ...(bodyLimit === undefined ? {} : { bodyLimit }),
  });
  await server.listen();
  const url = `${server.origin()}${PACKET_PATH}`;
  return { url, server };
}

const journalOf = async (sessionId: string): Promise<Record<string, unknown>[]> => {
  const text = await readFile(path.join(workPaths(project, workId).events, `${sessionId}.jsonl`), 'utf8').catch(() => '');
  return text.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as Record<string, unknown>);
};

const packetTextOf = (reply: Reply): string | undefined =>
  (JSON.parse(reply.body) as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
  process.env['PARLEY_HOME'] = home;
  delete process.env[PACKET_FAULT_ENV];
  workId = (await createWork(project, { title: 'Работа', goal: '' })).work.id;
  await updateMap(project, workId, (map) => {
    for (const label of ['лид', 'бэк', 'чужой']) addSession(map, { provider: 'claude', label, task: 'делать' });
    // s-01 и s-02 — в комнате; s-03 — вне комнат.
    addRoom(map, { title: 'Агенты', creator: 'human', members: ['s-01', 's-02'], lead: 's-01' });
  });
  await mkdir(workPaths(project, workId).events, { recursive: true });
});

afterEach(async () => {
  vi.useRealTimers();
  await server?.close();
  server = null;
  delete process.env['PARLEY_HOME'];
  delete process.env[PACKET_FAULT_ENV];
  await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('верный запрос', () => {
  it('токен и сессия из регистрации: пакет сессии в additionalContext, одна запись хоста с ревизией и размером; событие в ленту не идёт', async () => {
    const { url, server: hooks } = await boot();
    const token = hooks.register(refOf('s-02'), 'c-1', 'claude');
    const reply = await post(url, COMPACT, { token, session: 's-02' });
    expect(reply.status).toBe(200);
    const expected = await sessionRoomPacket(contextOf(refOf('s-02')));
    expect(expected?.ok).toBe(true);
    const text = packetTextOf(reply);
    expect(text).toBeDefined();
    // Содержимое то же, что отдаёт сборка пакета: сравнение по ревизии (время сборки в неё не входит).
    expect(text).toContain('viewer: member s-02');
    const records = await journalOf('s-02');
    expect(records).toHaveLength(1);
    // Размер — по `contextBytes` core (как у предела пакета), ревизия — та же, что у сборки в тот же момент.
    expect(records[0]).toMatchObject({ hook_event_name: ROOM_PACKET_EVENT, reason: 'sent', bytes: expected?.ok === true ? expected.bytes : -1 });
    expect(records[0]?.['revision']).toBe(expected?.ok === true ? expected.revision : undefined);
    expect(text).toContain(`Room state packet ${expected?.ok === true ? expected.revision : ''}`);
  });

  it('сессия берётся из регистрации, а не из тела: токен сессии вне комнаты не получает пакета комнаты, чьё имя стоит в теле', async () => {
    const { url, server: hooks } = await boot();
    const token = hooks.register(refOf('s-03'), 'c-3', 'claude');
    const reply = await post(url, { ...COMPACT, session: 's-02', sessionId: 's-02', room: 'r-01', roomId: 'r-01' }, { token, session: 's-03' });
    expect(reply).toEqual({ status: 200, body: '{}' });
    expect(await journalOf('s-02')).toEqual([]);
    expect(await journalOf('s-03')).toEqual([expect.objectContaining({ reason: 'no-packet', bytes: 0 })]);
  });
});

describe('отказы — без текста пакета и без записи в журнал сессии', () => {
  const expectNoJournal = async (): Promise<void> => {
    for (const id of ['s-01', 's-02', 's-03']) expect(await journalOf(id)).toEqual([]);
  };

  it('нет токена, чужой токен, чужой заголовок сессии, нет заголовка — 401/404', async () => {
    const { url, server: hooks } = await boot();
    const mine = hooks.register(refOf('s-02'), 'c-1', 'claude');
    const other = hooks.register(refOf('s-03'), 'c-3', 'claude');
    expect(await post(url, COMPACT, { session: 's-02' })).toEqual({ status: 401, body: '' });
    expect(await post(url, COMPACT, { token: 'f'.repeat(64), session: 's-02' })).toEqual({ status: 401, body: '' });
    // Токен чужой сессии с заголовком настоящей: заголовок сверяется с регистрацией токена.
    expect(await post(url, COMPACT, { token: other, session: 's-02' })).toEqual({ status: 404, body: '' });
    expect(await post(url, COMPACT, { token: mine, session: 's-03' })).toEqual({ status: 404, body: '' });
    expect(await post(url, COMPACT, { token: mine })).toEqual({ status: 404, body: '' });
    await expectNoJournal();
  });

  it('отозванный токен и токен прежнего запуска после нового — 401', async () => {
    const { url, server: hooks } = await boot();
    const first = hooks.register(refOf('s-02'), 'c-1', 'claude');
    const second = hooks.register(refOf('s-02'), 'c-1', 'claude');
    expect(await post(url, COMPACT, { token: first, session: 's-02' })).toEqual({ status: 401, body: '' });
    hooks.unregister(refOf('s-02'));
    expect(await post(url, COMPACT, { token: second, session: 's-02' })).toEqual({ status: 401, body: '' });
    await expectNoJournal();
  });

  it('тело сверх предела — 413', async () => {
    const { url, server: hooks } = await boot({}, 512);
    const token = hooks.register(refOf('s-02'), 'c-1', 'claude');
    expect(await post(url, { ...COMPACT, pad: 'x'.repeat(2048) }, { token, session: 's-02' })).toEqual({ status: 413, body: '' });
    await expectNoJournal();
  });

  it('событие не SessionStart(compact), не JSON и не объект — 400', async () => {
    const { url, server: hooks } = await boot();
    const token = hooks.register(refOf('s-02'), 'c-1', 'claude');
    const ask = (body: unknown): Promise<Reply> => post(url, body, { token, session: 's-02' });
    expect(await ask({ ...COMPACT, source: 'startup' })).toEqual({ status: 400, body: '' });
    expect(await ask({ ...COMPACT, source: 'resume' })).toEqual({ status: 400, body: '' });
    expect(await ask({ ...COMPACT, source: 'clear' })).toEqual({ status: 400, body: '' });
    expect(await ask({ hook_event_name: 'UserPromptSubmit', source: 'compact' })).toEqual({ status: 400, body: '' });
    expect(await ask({ hook_event_name: 'SessionStart' })).toEqual({ status: 400, body: '' });
    expect(await ask('{"hook_event_name":')).toEqual({ status: 400, body: '' });
    expect(await ask('[1]')).toEqual({ status: 400, body: '' });
    await expectNoJournal();
  });

  it('провайдер не claude (GLM и прочие) — 400', async () => {
    const { url, server: hooks } = await boot();
    const token = hooks.register(refOf('s-02'), 'c-1', 'glm');
    expect(await post(url, COMPACT, { token, session: 's-02' })).toEqual({ status: 400, body: '' });
    await expectNoJournal();
  });
});

describe('настройка roomPacket проверяется на каждом запросе', () => {
  it('выключена — пусто и ничего в журнале; включили — пакет; выключили — снова пусто, без перезапуска', async () => {
    let on = false;
    const { url, server: hooks } = await boot({ enabled: async () => on });
    const token = hooks.register(refOf('s-02'), 'c-1', 'claude');
    const ask = (): Promise<Reply> => post(url, COMPACT, { token, session: 's-02' });
    expect(await ask()).toEqual({ status: 200, body: '{}' });
    expect(await journalOf('s-02')).toEqual([]);
    on = true;
    expect(packetTextOf(await ask())).toContain('room r-01 "Агенты"');
    on = false;
    expect(await ask()).toEqual({ status: 200, body: '{}' });
    expect(await journalOf('s-02')).toHaveLength(1);
  });

  it('по умолчанию читает настройку из файла настроек и окружения: ключа нет — пусто; true в файле — пакет; false — пусто', async () => {
    const { url, server: hooks } = await boot({ enabled: undefined });
    const token = hooks.register(refOf('s-02'), 'c-1', 'claude');
    const ask = (): Promise<Reply> => post(url, COMPACT, { token, session: 's-02' });
    expect(await ask()).toEqual({ status: 200, body: '{}' });
    await writeFile(path.join(home, 'config.json'), JSON.stringify({ roomPacket: true }));
    expect(packetTextOf(await ask())).toBeDefined();
    await writeFile(path.join(home, 'config.json'), JSON.stringify({ roomPacket: false }));
    expect(await ask()).toEqual({ status: 200, body: '{}' });
  });
});

describe('записи журнала и сбои', () => {
  it('сбой записи в журнал не меняет ответ', async () => {
    const { url, server: hooks } = await boot({ journal: () => { throw new Error('disk full'); } });
    const token = hooks.register(refOf('s-02'), 'c-1', 'claude');
    expect(packetTextOf(await post(url, COMPACT, { token, session: 's-02' }))).toContain('viewer: member s-02');
  });

  it('сбой сборки — пустой ответ и запись build-failed; сессия вне комнат — пусто и запись no-packet', async () => {
    const { url, server: hooks } = await boot({ context: async () => { throw new Error('store is down'); } });
    const token = hooks.register(refOf('s-02'), 'c-1', 'claude');
    expect(await post(url, COMPACT, { token, session: 's-02' })).toEqual({ status: 200, body: '{}' });
    expect(await journalOf('s-02')).toEqual([expect.objectContaining({ hook_event_name: ROOM_PACKET_EVENT, reason: 'build-failed' })]);
  });
});

describe('испытательная переменная PARLEY_ROOM_PACKET_FAULT', () => {
  it('допустимы ровно два значения; всё остальное ничего не делает', () => {
    expect(parsePacketFault('drop')).toEqual({ kind: 'drop' });
    expect(parsePacketFault('delay:5000')).toEqual({ kind: 'delay', ms: 5000 });
    for (const value of [undefined, '', 'DROP', 'delay', 'delay:0', 'delay:5001', 'delay:5000 ', ' drop', 'drop:1', 'none', '1']) {
      expect(parsePacketFault(value), String(value)).toBeNull();
    }
  });

  it('по умолчанию значение берётся из окружения хоста', async () => {
    const { url, server: hooks } = await boot({ fault: undefined });
    const token = hooks.register(refOf('s-02'), 'c-1', 'claude');
    process.env[PACKET_FAULT_ENV] = 'drop';
    await expect(post(url, COMPACT, { token, session: 's-02' })).rejects.toThrow();
    process.env[PACKET_FAULT_ENV] = 'nonsense';
    expect(packetTextOf(await post(url, COMPACT, { token, session: 's-02' }))).toBeDefined();
  });

  it('drop: соединение закрыто без ответа, пакета нет, записи хоста нет; хост и следующий запрос живы', async () => {
    let fault: string | undefined = 'drop';
    const { url, server: hooks } = await boot({ fault: () => fault });
    const token = hooks.register(refOf('s-02'), 'c-1', 'claude');
    await expect(post(url, COMPACT, { token, session: 's-02' })).rejects.toThrow();
    expect(await journalOf('s-02')).toEqual([]);
    fault = undefined;
    expect(packetTextOf(await post(url, COMPACT, { token, session: 's-02' }))).toBeDefined();
  });

  it('delay:5000: ответ с пакетом приходит через 5 с; таймер один', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { url, server: hooks } = await boot({ fault: () => 'delay:5000' });
    const token = hooks.register(refOf('s-02'), 'c-1', 'claude');
    const pending = post(url, COMPACT, { token, session: 's-02' });
    await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1));
    expect(await journalOf('s-02')).toEqual([]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(packetTextOf(await pending)).toBeDefined();
    expect(await journalOf('s-02')).toHaveLength(1);
  });

  it('delay:5000: разрыв соединения снимает таймер, ответ не пишется, записи хоста нет', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { url, server: hooks } = await boot({ fault: () => 'delay:5000' });
    const token = hooks.register(refOf('s-02'), 'c-1', 'claude');
    const target = new URL(url);
    const payload = JSON.stringify(COMPACT);
    const req = httpRequest({
      host: target.hostname, port: target.port, path: target.pathname, method: 'POST', agent: false,
      headers: { Authorization: `Bearer ${token}`, 'X-Parley-Session': 's-02', 'Content-Length': String(Buffer.byteLength(payload)) },
    });
    req.on('error', () => {});
    req.end(payload);
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
    req.destroy();
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(0));
    await vi.advanceTimersByTimeAsync(6000);
    expect(await journalOf('s-02')).toEqual([]);
  });

  it('delay:5000: остановка хоста отвечает {} висящему запросу и не ждёт таймер', async () => {
    const { url, server: hooks } = await boot({ fault: () => 'delay:5000' });
    const token = hooks.register(refOf('s-02'), 'c-1', 'claude');
    const pending = post(url, COMPACT, { token, session: 's-02' });
    await vi.waitFor(() => expect(hooks.url()).not.toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 100));
    const started = Date.now();
    await hooks.close();
    expect(Date.now() - started).toBeLessThan(3000);
    expect(await pending).toEqual({ status: 200, body: '{}' });
  });

  it('сбой не касается запросов без права, с неверным телом и при выключенной настройке', async () => {
    for (const value of ['drop', 'delay:5000']) {
      let on = true;
      const { url, server: hooks } = await boot({ fault: () => value, enabled: async () => on });
      const token = hooks.register(refOf('s-02'), 'c-1', 'claude');
      expect(await post(url, COMPACT, { session: 's-02' })).toEqual({ status: 401, body: '' });
      expect(await post(url, COMPACT, { token, session: 's-03' })).toEqual({ status: 404, body: '' });
      expect(await post(url, { ...COMPACT, source: 'startup' }, { token, session: 's-02' })).toEqual({ status: 400, body: '' });
      on = false;
      expect(await post(url, COMPACT, { token, session: 's-02' })).toEqual({ status: 200, body: '{}' });
      await server?.close();
      server = null;
    }
  });
});

describe('на /hooks сбой не влияет', () => {
  it('с выставленной переменной обычный путь /hooks отвечает как раньше', async () => {
    process.env[PACKET_FAULT_ENV] = 'drop';
    const { server: hooks } = await boot({ fault: undefined });
    const token = hooks.register(refOf('s-02'), 'c-1', 'claude');
    const reply = await post(`${hooks.origin()}/hooks`, { hook_event_name: 'Stop', session_id: 'c-1' }, { token, session: 's-02' }).catch(() => null);
    // Событие уходит в onHook стенда, который бросает: приёмник отвечает `{}` (обработчик упал), а не рвёт соединение.
    expect(reply).toEqual({ status: 200, body: '{}' });
  });
});
