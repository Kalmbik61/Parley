import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addRoom, addSession, createWork, readMap, readWorksIndex, transitionSession, updateMap, workPaths } from '@parley/core';
import { COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE } from '@parley/protocol';
import { connectRaw, hello, holdDatabase, removeHome, tempHome, waitConnected } from '../../test/helpers.js';
import type { RawMessage, TestClient } from '../../test/helpers.js';
import { startHost } from '../host.js';
import type { RunningHost } from '../host.js';
import { hostPaths } from '../paths.js';

/** Второе соединение с базой дома — испортить строку работы, как это сделал бы чужой процесс или диск. */
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

let hosts: RunningHost[] = [];
let homes: string[] = [];
let projects: string[] = [];

async function boot(): Promise<{ home: string; token: string }> {
  const home = await tempHome();
  homes.push(home);
  const running = await startHost({ home });
  hosts.push(running);
  const token = await readFile(hostPaths(home).token, 'utf8');
  return { home, token };
}

async function project(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'parley-methods-project-'));
  projects.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(hosts.map((h) => h.context.shutdown('test-cleanup').catch(() => {})));
  hosts = [];
  await Promise.all(homes.map((home) => removeHome(home)));
  homes = [];
  await Promise.all(projects.map((dir) => rm(dir, { recursive: true, force: true })));
  projects = [];
});

describe('works.create / works.delete', () => {
  it('works.create заводит каталог и строку работы в базе', async () => {
    const { home, token } = await boot();
    const dir = await project();
    const client = connectRaw(hostPaths(home).socket);
    await waitConnected(client.socket);
    await hello(client, token);

    client.send({
      id: 1,
      method: 'works.create',
      params: { projectPath: dir, title: 'Авторизация', goal: 'логин по паролю' },
    });
    const response = await client.next();
    const workId = (response.result as { workId: string }).workId;
    expect(workId).toBe('w-0001');

    expect((await readWorksIndex()).works).toContainEqual(
      expect.objectContaining({ id: workId, projectPath: dir, title: 'Авторизация' }),
    );
    expect((await readMap(dir, workId)).work.title).toBe('Авторизация');

    client.close();
  });

  it('works.delete при живой сессии — conflict', async () => {
    const { home, token } = await boot();
    const dir = await project();
    const client = connectRaw(hostPaths(home).socket);
    await waitConnected(client.socket);
    await hello(client, token);

    client.send({ id: 1, method: 'works.create', params: { projectPath: dir, title: 'Работа', goal: '' } });
    const created = await client.next();
    const workId = (created.result as { workId: string }).workId;

    await updateMap(dir, workId, (map) => {
      const session = addSession(map, { provider: 'claude', label: 'план', task: 't' });
      session.pid = process.pid;
      transitionSession(map, session.id, 'active');
    });

    client.send({ id: 2, method: 'works.delete', params: { projectPath: dir, workId } });
    const response = await client.next();
    expect(response.error).toMatchObject({ code: 'conflict', message: `workspace ${workId} has a live session` });
    // Работа осталась в базе.
    expect((await readMap(dir, workId)).work.title).toBe('Работа');

    client.close();
  });

  it('works.delete без живой сессии — удаляет', async () => {
    const { home, token } = await boot();
    const dir = await project();
    const client = connectRaw(hostPaths(home).socket);
    await waitConnected(client.socket);
    await hello(client, token);

    client.send({ id: 1, method: 'works.create', params: { projectPath: dir, title: 'Работа', goal: '' } });
    const created = await client.next();
    const workId = (created.result as { workId: string }).workId;

    client.send({ id: 2, method: 'works.delete', params: { projectPath: dir, workId } });
    const response = await client.next();
    expect(response.result).toEqual({ ok: true });
    expect((await readWorksIndex()).works).toEqual([]);

    client.close();
  });
});

describe('works.create: первая работа нового проекта без сессии', () => {
  /** Следующее сообщение или null по таймауту — чтобы тест падал ожиданием, а не зависал. */
  async function nextWithin(client: TestClient, ms: number): Promise<RawMessage | null> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    });
    try {
      return await Promise.race([client.next(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  it('сразу попадает в снимок: works.changed с работой приходит, works.list её содержит', async () => {
    const { home, token } = await boot();
    const dir = await project();
    const client = connectRaw(hostPaths(home).socket);
    await waitConnected(client.socket);
    await hello(client, token);

    client.send({ id: 1, method: 'works.create', params: { projectPath: dir, title: 'Новая', goal: '' } });
    let workId: string | null = null;
    let changed = false;
    const hasWork = (data: unknown): boolean =>
      (data as { entries: Array<{ projectPath: string; map: { work: { id: string } } }> }).entries.some(
        (entry) => entry.projectPath === dir && entry.map.work.id === workId,
      );
    // Ни одна запись карты после создания не случается — снимок обязан обновиться сам: строка работы создаётся одной записью базы.
    const deadline = Date.now() + 3000;
    while (!changed && Date.now() < deadline) {
      const message = await nextWithin(client, deadline - Date.now());
      if (message === null) break;
      if (message.id === 1) workId = (message.result as { workId: string }).workId;
      else if (message.event === 'works.changed' && workId !== null && hasWork(message.data)) {
        changed = true;
      }
    }
    expect(workId).toBe('w-0001');
    expect(changed).toBe(true);

    client.send({ id: 2, method: 'works.list', params: {} });
    const list = await reply(client, 2);
    expect(hasWork(list.result)).toBe(true);

    client.close();
  });
});

/** Ответ на запрос `id`: события `works.changed` и прочие рассылки между ними пропускаются. */
async function reply(client: TestClient, id: number): Promise<RawMessage> {
  for (;;) {
    const message = await client.next();
    if (message.id === id) return message;
  }
}

describe('works.rename / works.setStatus', () => {
  async function withWork(): Promise<{ client: TestClient; dir: string; workId: string; home: string }> {
    const { home, token } = await boot();
    const dir = await project();
    const client = connectRaw(hostPaths(home).socket);
    await waitConnected(client.socket);
    await hello(client, token);
    client.send({ id: 1, method: 'works.create', params: { projectPath: dir, title: 'Старая', goal: '' } });
    const workId = ((await reply(client, 1)).result as { workId: string }).workId;
    return { client, dir, workId, home };
  }

  it('works.rename с пустым названием — bad_request, карта не тронута', async () => {
    const { client, dir, workId } = await withWork();

    client.send({ id: 2, method: 'works.rename', params: { projectPath: dir, workId, title: '   ' } });
    expect((await reply(client, 2)).error?.code).toBe('bad_request');
    expect((await readMap(dir, workId)).work.title).toBe('Старая');
    client.close();
  });

  it('works.rename меняет название в карте', async () => {
    const { client, dir, workId } = await withWork();

    client.send({ id: 2, method: 'works.rename', params: { projectPath: dir, workId, title: '  Новая  ' } });
    expect((await reply(client, 2)).result).toEqual({ ok: true });
    expect((await readMap(dir, workId)).work.title).toBe('Новая');
    client.close();
  });

  it('works.setStatus пишет статус в карту', async () => {
    const { client, dir, workId } = await withWork();

    client.send({ id: 2, method: 'works.setStatus', params: { projectPath: dir, workId, status: 'done' } });
    expect((await reply(client, 2)).result).toEqual({ ok: true });
    expect((await readMap(dir, workId)).work.status).toBe('done');
    client.close();
  });

  it('несуществующая работа — not_found, а не internal', async () => {
    const { client, dir } = await withWork();

    client.send({ id: 2, method: 'works.rename', params: { projectPath: dir, workId: 'w-9999', title: 'Икс' } });
    expect((await reply(client, 2)).error).toMatchObject({
      code: 'not_found',
      message: 'workspace w-9999 does not exist',
    });
    client.send({
      id: 3,
      method: 'works.setStatus',
      params: { projectPath: dir, workId: 'w-9999', status: 'archived' },
    });
    expect((await reply(client, 3)).error?.code).toBe('not_found');
    client.close();
  });

  it('работа, которую база хранит, но разобрать нельзя, — internal, а не not_found', async () => {
    const { client, dir, workId, home } = await withWork();
    // Строка работы на месте (`requireWork` её видит), а карта из неё не собирается; версия растёт, чтобы кэш карт не спас запись.
    const db = new DatabaseSync(path.join(home, 'parley.db'));
    try {
      db.prepare('UPDATE works SET work_json = ?, version = version + 1 WHERE project_path = ? AND id = ?').run('not json', dir, workId);
    } finally {
      db.close();
    }

    client.send({ id: 2, method: 'works.rename', params: { projectPath: dir, workId, title: 'Икс' } });
    const renamed = (await reply(client, 2)).error;
    client.send({ id: 3, method: 'works.setStatus', params: { projectPath: dir, workId, status: 'archived' } });
    const archived = (await reply(client, 3)).error;

    for (const error of [renamed, archived]) {
      expect(error?.code).toBe('internal');
      expect(error?.code).not.toBe('not_found');
    }
    client.close();
  });

  // Раунд исправлений 1, находка 2: работу удалили между проверкой обработчика и
  // записью. База занята заранее другим процессом, который внутри захвата снимает работу: запрос
  // гарантированно встаёт в ожидание уже после проверки, — иначе гонку почти всегда выигрывает not_found.
  for (const [method, extra] of [
    ['works.rename', { title: 'Икс' }],
    ['works.setStatus', { status: 'archived' }],
  ] as const) {
    it(`${method}: работа удалена, пока запись ждала базу — not_found, хост жив`, async () => {
      const { client, dir, workId, home } = await withWork();
      const held = await holdDatabase(home, 300, { projectPath: dir, workId });

      client.send({ id: 2, method, params: { projectPath: dir, workId, ...extra } });

      expect((await reply(client, 2)).error?.code).toBe('not_found');
      await held.done;
      client.send({ id: 3, method: 'works.list', params: {} });
      expect((await reply(client, 3)).result).toBeDefined();
      client.close();
    });
  }
});

describe('providers.list', () => {
  it('PARLEY_CLAUDE_BIN на исполняемый стаб — у claude available: true', async () => {
    const { home, token } = await boot();
    const stubDir = await mkdtemp(path.join(tmpdir(), 'parley-stub-'));
    const stub = path.join(stubDir, 'claude-stub');
    await writeFile(stub, '#!/bin/sh\n', 'utf8');
    await chmod(stub, 0o755);
    const saved = process.env['PARLEY_CLAUDE_BIN'];
    process.env['PARLEY_CLAUDE_BIN'] = stub;

    try {
      const client = connectRaw(hostPaths(home).socket);
      await waitConnected(client.socket);
      await hello(client, token);

      client.send({ id: 1, method: 'providers.list', params: {} });
      const response = await client.next();
      const providers = (response.result as { providers: Array<{ id: string; available: boolean }> })
        .providers;
      expect(providers.find((p) => p.id === 'claude')?.available).toBe(true);

      client.close();
    } finally {
      if (saved === undefined) delete process.env['PARLEY_CLAUDE_BIN'];
      else process.env['PARLEY_CLAUDE_BIN'] = saved;
      await rm(stubDir, { recursive: true, force: true });
    }
  });
});

describe('settings.get / settings.set', () => {
  it('settings.get: ключ из переменной окружения попадает в locked', async () => {
    const { home, token } = await boot();
    const saved = process.env['PARLEY_MESSAGE_RATE'];
    process.env['PARLEY_MESSAGE_RATE'] = '5';

    try {
      const client = connectRaw(hostPaths(home).socket);
      await waitConnected(client.socket);
      await hello(client, token);

      client.send({ id: 1, method: 'settings.get', params: {} });
      const response = await client.next();
      const result = response.result as { locked: Record<string, string> };
      expect(result.locked['messageRate']).toBe('PARLEY_MESSAGE_RATE');

      client.close();
    } finally {
      if (saved === undefined) delete process.env['PARLEY_MESSAGE_RATE'];
      else process.env['PARLEY_MESSAGE_RATE'] = saved;
    }
  });

  it('settings.get: прежняя переменная HARNAS_* тоже замок — и называется так, как задана', async () => {
    const { home, token } = await boot();
    const saved = { parley: process.env['PARLEY_MESSAGE_RATE'], harnas: process.env['HARNAS_MESSAGE_RATE'] };
    delete process.env['PARLEY_MESSAGE_RATE'];
    process.env['HARNAS_MESSAGE_RATE'] = '5';

    try {
      const client = connectRaw(hostPaths(home).socket);
      await waitConnected(client.socket);
      await hello(client, token);

      client.send({ id: 1, method: 'settings.get', params: {} });
      const response = await client.next();
      const result = response.result as { config: { messageRate: number }; locked: Record<string, string> };
      expect(result.config.messageRate).toBe(5);
      expect(result.locked['messageRate']).toBe('HARNAS_MESSAGE_RATE');

      client.close();
    } finally {
      if (saved.parley === undefined) delete process.env['PARLEY_MESSAGE_RATE'];
      else process.env['PARLEY_MESSAGE_RATE'] = saved.parley;
      if (saved.harnas === undefined) delete process.env['HARNAS_MESSAGE_RATE'];
      else process.env['HARNAS_MESSAGE_RATE'] = saved.harnas;
    }
  });

  it('settings.set с плохим значением — bad_request', async () => {
    const { home, token } = await boot();
    const client = connectRaw(hostPaths(home).socket);
    await waitConnected(client.socket);
    await hello(client, token);

    client.send({ id: 1, method: 'settings.set', params: { key: 'messageRate', value: 'абв' } });
    const response = await client.next();
    expect(response.error?.code).toBe('bad_request');

    client.close();
  });

  it('settings.set с неизвестным ключом — bad_request с именем ключа', async () => {
    const { home, token } = await boot();
    const client = connectRaw(hostPaths(home).socket);
    await waitConnected(client.socket);
    await hello(client, token);

    client.send({ id: 1, method: 'settings.set', params: { key: 'noSuchSetting', value: '1' } });
    const response = await client.next();
    expect(response.error).toMatchObject({ code: 'bad_request', message: 'unknown setting: noSuchSetting' });

    client.close();
  });

  it('settings.set с хорошим значением — сохраняет и возвращает конфиг', async () => {
    const { home, token } = await boot();
    const client = connectRaw(hostPaths(home).socket);
    await waitConnected(client.socket);
    await hello(client, token);

    client.send({ id: 1, method: 'settings.set', params: { key: 'messageRate', value: '7' } });
    const response = await client.next();
    expect((response.result as { config: { messageRate: number } }).config.messageRate).toBe(7);

    client.close();
  });
});

describe('works.list по признакам окна (спека rooms.mail 6.8, 6.10)', () => {
  it('окно с rooms-mail получает снимок без писем, окно с compact-works — с хвостами, прежнее — полный: тот же вариант, что и в works.changed', async () => {
    const home = await tempHome();
    homes.push(home);
    const dir = await project();
    const previousHome = process.env['PARLEY_HOME'];
    process.env['PARLEY_HOME'] = home;
    const map = await createWork(dir, { title: 'Работа' });
    await updateMap(dir, map.work.id, (current, letters) => {
      addSession(current, { provider: 'claude', label: 'план', task: 't' });
      addRoom(current, { title: 'Комната', creator: 'human', members: ['s-01'], lead: 's-01' });
      for (let i = 0; i < 30; i += 1) letters.add({ kind: 'note', from: 's-01', to: [], roomId: 'r-01', text: `письмо ${i}` });
    });
    if (previousHome === undefined) delete process.env['PARLEY_HOME'];
    else process.env['PARLEY_HOME'] = previousHome;

    const running = await startHost({ home });
    hosts.push(running);
    const token = await readFile(hostPaths(home).token, 'utf8');
    type Entry = { version?: number; map: { messages: unknown[]; compact?: { version: number; messages?: unknown; rooms?: Record<string, { total: number; top: number }> } } };
    const list = async (features: string[]): Promise<Entry> => {
      const client = connectRaw(hostPaths(home).socket);
      await waitConnected(client.socket);
      await hello(client, token, { features });
      client.send({ id: 1, method: 'works.list', params: {} });
      const response = await reply(client, 1);
      client.close();
      return (response.result as { entries: Entry[] }).entries[0] as Entry;
    };

    const mail = await list([COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE]);
    const compact = await list([COMPACT_WORKS_FEATURE]);
    const legacy = await list([]);

    expect(mail.map.messages).toEqual([]);
    expect(mail.map.compact).toMatchObject({ version: 2, rooms: { 'r-01': { total: 30, top: 30 } } });
    expect(mail.map.compact).not.toHaveProperty('messages');
    expect(compact.map.messages).toHaveLength(30);
    expect(compact.map.compact).toMatchObject({ version: 1, messages: { total: 30 } });
    expect(legacy.map.messages).toHaveLength(30);
    expect(legacy.map.compact).toBeUndefined();
    expect(mail.version).toBeDefined();
    expect(mail.version).toBe(compact.version);
  });
});

describe('works.list на старте хоста', () => {
  it('отвечает снимком после первого чтения работ хостом, а не тем, что успело набраться до него', async () => {
    // Окно подключается сразу после listen, а хост читает работы и сверяет живость уже после
    // него. Прежде works.list в это окно отдавал недочитанный снимок (пустой — окно считало
    // работы исчезнувшими и закрывало их вкладки; или с active мёртвой сессии): fix-tests2,
    // restart-host. Запись сверки здесь держит чужой процесс, занявший базу, — ответ обязан её дождаться.
    const home = await tempHome();
    homes.push(home);
    const dir = await project();
    const previousHome = process.env['PARLEY_HOME'];
    process.env['PARLEY_HOME'] = home;
    const map = await createWork(dir, { title: 'Работа' });
    await updateMap(dir, map.work.id, (current) => {
      const session = addSession(current, { provider: 'claude', label: 'план', task: 't' });
      session.launchedBy = 'host';
      session.pid = 999_999;
      transitionSession(current, session.id, 'active');
    });
    if (previousHome === undefined) delete process.env['PARLEY_HOME'];
    else process.env['PARLEY_HOME'] = previousHome;

    const held = await holdDatabase(home, 300);
    const starting = startHost({ home });
    starting.then((running) => hosts.push(running)).catch(() => {});

    const paths = hostPaths(home);
    let token = '';
    for (const deadline = Date.now() + 5000; Date.now() < deadline; ) {
      token = await readFile(paths.token, 'utf8').catch(() => '');
      if (token !== '' && existsSync(paths.socket)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const client = connectRaw(paths.socket);
    await waitConnected(client.socket);
    await hello(client, token);
    client.send({ id: 1, method: 'works.list', params: {} });

    // До ответа могут прийти события (works.changed первого чтения) — ищем ответ по id.
    let response = await client.next();
    while (response.id !== 1) response = await client.next();
    const entries = (response.result as { entries: Array<{ map: { sessions: Array<{ lifecycle: string }> } }> }).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.map.sessions[0]?.lifecycle).toBe('sleeping');
    await starting;
    await held.done;
    client.close();
  });
});

describe('sessions.* на старте хоста (lane-r4, п. 4)', () => {
  it('sessions.interrupted до первого чтения работ отвечает по прочитанному снимку, а не пустым списком', async () => {
    // Окно на старте спрашивает прерванные сессии (баннер): ответ до первого чтения работ и
    // сбора прерванных был пустым, и баннер не появлялся. Запись сверки держит чужой процесс, занявший базу.
    const home = await tempHome();
    homes.push(home);
    const dir = await project();
    const previousHome = process.env['PARLEY_HOME'];
    process.env['PARLEY_HOME'] = home;
    const map = await createWork(dir, { title: 'Работа' });
    let sessionId = '';
    await updateMap(dir, map.work.id, (current) => {
      const session = addSession(current, { provider: 'claude', label: 'план', task: 't' });
      session.launchedBy = 'host';
      session.pid = 999_999;
      sessionId = session.id;
      transitionSession(current, session.id, 'active');
    });
    if (previousHome === undefined) delete process.env['PARLEY_HOME'];
    else process.env['PARLEY_HOME'] = previousHome;
    // Журнал оборван посреди хода: хост упал, пока агент работал.
    const events = workPaths(dir, map.work.id).events;
    await mkdir(events, { recursive: true });
    await writeFile(path.join(events, `${sessionId}.jsonl`), `${JSON.stringify({ hook_event_name: 'UserPromptSubmit' })}\n`);

    const held = await holdDatabase(home, 300);
    const starting = startHost({ home });
    starting.then((running) => hosts.push(running)).catch(() => {});

    const paths = hostPaths(home);
    let token = '';
    for (const deadline = Date.now() + 5000; Date.now() < deadline; ) {
      token = await readFile(paths.token, 'utf8').catch(() => '');
      if (token !== '' && existsSync(paths.socket)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const client = connectRaw(paths.socket);
    await waitConnected(client.socket);
    await hello(client, token);
    client.send({ id: 1, method: 'sessions.interrupted', params: {} });

    let response = await client.next();
    while (response.id !== 1) response = await client.next();
    expect(response.result).toEqual({ refs: [{ projectPath: dir, workId: map.work.id, sessionId }] });
    await starting;
    await held.done;
    client.close();
  });
});

describe('отказ первого чтения работ (lane-r5, п. 1)', () => {
  it('битый works-index.json — хост поднят, методы снимка отвечают ошибкой с причиной, прочие методы работают', async () => {
    // Прежде worksService.start() бросал уже после listen: ворота worksReady не открывались и не
    // отказывали — works.list и остальные методы снимка висели навсегда (review-fix-tests2-A, I1).
    const home = await tempHome();
    homes.push(home);
    await writeFile(path.join(home, 'works-index.json'), '{"schemaVersion": 7}');
    const running = await startHost({ home });
    hosts.push(running);

    const paths = hostPaths(home);
    const client = connectRaw(paths.socket);
    await waitConnected(client.socket);
    await hello(client, await readFile(paths.token, 'utf8'));
    // Уведомление за теми же воротами не роняет хост отказом.
    client.send({ method: 'activity.seen', params: { ref: { projectPath: '/tmp/x', workId: 'w-0001', sessionId: 'S01' } } });
    client.send({ id: 1, method: 'works.list', params: {} });
    client.send({ id: 2, method: 'sessions.interrupted', params: {} });
    client.send({ id: 3, method: 'host.info', params: {} });

    const byId = new Map<unknown, RawMessage>();
    while (byId.size < 3) {
      const message = await client.next();
      if (message.id !== undefined) byId.set(message.id, message);
    }
    for (const id of [1, 2]) {
      expect(byId.get(id)?.error).toMatchObject({ code: 'internal', data: { reason: 'works-unreadable' } });
    }
    expect(byId.get(3)?.result).toBeDefined();
    client.close();
  });
});
