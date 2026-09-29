import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addSession, createWork, updateMap, workPaths } from '@harnas/core';
import { connectRaw, hello, removeHome, tempHome, waitConnected } from '../../test/helpers.js';
import type { RawMessage, TestClient } from '../../test/helpers.js';
import { startHost } from '../host.js';
import type { HostOptions, RunningHost } from '../host.js';
import { hostPaths } from '../paths.js';

let hosts: RunningHost[] = [];
let homes: string[] = [];
let clients: TestClient[] = [];
let extraEnv: string[] = [];

afterEach(async () => {
  for (const client of clients) client.close();
  clients = [];
  await Promise.all(hosts.map((h) => h.context.shutdown('test-cleanup').catch(() => {})));
  hosts = [];
  await Promise.all(homes.map((home) => removeHome(home)));
  homes = [];
  for (const key of extraEnv) delete process.env[key];
  extraEnv = [];
});

interface ProviderItem {
  id: string;
  label: string;
  available: boolean;
  models: string[] | null;
  effort: boolean;
  version: string | null;
  limits: { fiveHour: { usedPercent: number } | null; week: { usedPercent: number } | null; at: string } | null;
}

/**
 * Хост с подменённой пробой версий. Настоящие claude и codex не запускаются: `probeVersion`
 * — подмена, а `startHost` без неё ничего не пробует.
 */
async function boot(
  options: {
    probeVersion?: (command: string) => Promise<string | null>;
    providersJson?: unknown;
    /** Готовит дом до старта хоста: работы, файлы лимитов. */
    prepare?: (home: string) => Promise<void>;
    limits?: HostOptions['limits'];
  } = {},
): Promise<TestClient> {
  const home = await tempHome();
  homes.push(home);
  if (options.providersJson !== undefined) {
    await writeFile(path.join(home, 'providers.json'), JSON.stringify(options.providersJson), 'utf8');
  }
  await options.prepare?.(home);
  const running = await startHost({
    home,
    ...(options.probeVersion === undefined ? {} : { probeVersion: options.probeVersion }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  hosts.push(running);
  const token = await readFile(hostPaths(home).token, 'utf8');
  const client = connectRaw(hostPaths(home).socket);
  clients.push(client);
  await waitConnected(client.socket);
  await hello(client, token);
  return client;
}

let nextId = 1;
async function list(client: TestClient): Promise<ProviderItem[]> {
  const id = nextId;
  nextId += 1;
  client.send({ id, method: 'providers.list', params: {} });
  for (;;) {
    const message: RawMessage = await client.next();
    if (message.id === id) return (message.result as { providers: ProviderItem[] }).providers;
  }
}

const byId = (providers: ProviderItem[], id: string): ProviderItem => {
  const found = providers.find((provider) => provider.id === id);
  if (found === undefined) throw new Error(`провайдера ${id} нет в ответе`);
  return found;
};

describe('providers.list: модели, усилие и версия CLI (дизайн комнат, 3.2)', () => {
  it('claude и codex умеют effort, версия — из пробы; glm ничего не умеет и без версии', async () => {
    const client = await boot({
      probeVersion: async (command) => (command === 'claude' ? '2.1.276' : command === 'codex' ? '0.44.0' : null),
    });
    const providers = await list(client);

    expect(byId(providers, 'claude')).toMatchObject({ label: 'Claude', effort: true, models: null, version: '2.1.276' });
    expect(byId(providers, 'codex')).toMatchObject({ label: 'Codex', effort: true, models: null, version: '0.44.0' });
    expect(byId(providers, 'glm')).toMatchObject({ label: 'GLM', effort: false, models: null, version: null });
    expect(typeof byId(providers, 'claude').available).toBe('boolean');
  });

  it('без пробы версий нет: null у всех — это окно и тесты, где команды не запускаются', async () => {
    const providers = await list(await boot());
    expect(providers.map((provider) => provider.version)).toEqual([null, null, null]);
  });

  it('проба падает — версия null, список отвечает', async () => {
    const providers = await list(
      await boot({
        probeVersion: async () => {
          throw new Error('нет такой команды');
        },
      }),
    );
    expect(providers.every((provider) => provider.version === null)).toBe(true);
  });

  it('проба одна на команду на весь хост: повторные providers.list её не повторяют', async () => {
    const calls: string[] = [];
    const client = await boot({
      probeVersion: async (command) => {
        calls.push(command);
        return '1.0.0';
      },
    });

    await list(client);
    await list(client);
    await list(client);
    expect(calls.sort()).toEqual(['claude', 'codex', 'glm']);
  });

  it('первый providers.list дожидается пробы, а не отвечает пустой версией', async () => {
    const client = await boot({
      probeVersion: async (command) => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return command === 'claude' ? '2.1.276' : null;
      },
    });
    expect(byId(await list(client), 'claude').version).toBe('2.1.276');
  });

  it('список моделей из providers.json отдаётся, если шаблон запуска принимает модель', async () => {
    const providers = await list(
      await boot({
        providersJson: {
          codex: { models: ['gpt-5.5', 'gpt-5.5-mini'] },
          // Свой провайдер без {model} в шаблоне: список окну не нужен — модель до команды не доедет.
          opencode: { badge: 'OpenCode', command: 'opencode', args: ['{prompt}'], models: ['a', 'b'] },
          // …а с {model} и {effort} в шаблоне провайдер их принимает.
          smart: { badge: 'Smart', command: 'smart', args: ['--m', '{model}', '--e', '{effort}'], models: ['fast'] },
        },
      }),
    );

    expect(byId(providers, 'codex').models).toEqual(['gpt-5.5', 'gpt-5.5-mini']);
    expect(byId(providers, 'opencode')).toMatchObject({ models: null, effort: false });
    expect(byId(providers, 'smart')).toMatchObject({ models: ['fast'], effort: true });
    expect(byId(providers, 'claude').models).toBeNull();
  });

  it('available: команда есть в PATH или подменена оверрайдом — как и прежде', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'harnas-providers-bin-'));
    const file = path.join(dir, 'claude-stub');
    await writeFile(file, '#!/bin/sh\n', 'utf8');
    await chmod(file, 0o755);
    process.env['HARNAS_CLAUDE_BIN'] = file;
    process.env['HARNAS_CODEX_BIN'] = path.join(dir, 'нет-такого');
    extraEnv.push('HARNAS_CLAUDE_BIN', 'HARNAS_CODEX_BIN');

    const providers = await list(await boot());
    expect(byId(providers, 'claude').available).toBe(true);
    expect(byId(providers, 'codex').available).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('providers.list: лимиты подписок и событие providers.limitsChanged (спека комнат, 3.5)', () => {
  const inHour = (): number => Math.floor(Date.now() / 1000) + 3600;
  const inDay = (): number => Math.floor(Date.now() / 1000) + 86_400;
  let projects: string[] = [];

  afterEach(async () => {
    await Promise.all(projects.map((dir) => rm(dir, { recursive: true, force: true })));
    projects = [];
  });

  /** Работа с сессиями claude и glm в новом проекте; возвращает каталог работы. */
  async function prepareWork(home: string): Promise<{ workDir: string; claude: string; glm: string }> {
    const project = await mkdtemp(path.join(tmpdir(), 'harnas-providers-limits-'));
    projects.push(project);
    process.env['HARNAS_HOME'] = home;
    try {
      const created = await createWork(project, { title: 'Лимиты' });
      const map = await updateMap(project, created.work.id, (draft) => {
        addSession(draft, { provider: 'claude', label: 'один', task: 'задача' });
        addSession(draft, { provider: 'glm', label: 'два', task: 'задача' });
      });
      const [claude, glm] = map.sessions.map((session) => session.id);
      return { workDir: workPaths(project, created.work.id).dir, claude: claude as string, glm: glm as string };
    } finally {
      delete process.env['HARNAS_HOME'];
    }
  }

  /** Файл строки статуса, как его пишет скрипт: { at, rateLimits }; `ageMs` — давность `at`. */
  async function putLimits(
    workDir: string,
    session: string,
    fiveHour: number,
    week: number,
    ageMs = 0,
  ): Promise<void> {
    await mkdir(path.join(workDir, 'limits'), { recursive: true });
    await writeFile(
      path.join(workDir, 'limits', `${session}.json`),
      JSON.stringify({
        at: new Date(Date.now() - ageMs).toISOString(),
        rateLimits: {
          five_hour: { used_percentage: fiveHour, resets_at: inHour() },
          seven_day: { used_percentage: week, resets_at: inDay() },
        },
      }),
    );
  }

  /** Всё, что пришло до ответа на запрос `id`, включая события. */
  async function untilResponse(client: TestClient, id: number): Promise<RawMessage[]> {
    const seen: RawMessage[] = [];
    for (;;) {
      const message = await client.next();
      seen.push(message);
      if (message.id === id) return seen;
    }
  }

  it('limits у каждого провайдера — из файлов его сессий; файл GLM (свежее) не становится лимитами Claude', async () => {
    const client = await boot({
      prepare: async (home) => {
        const work = await prepareWork(home);
        await putLimits(work.workDir, work.claude, 58, 41, 60_000);
        await putLimits(work.workDir, work.glm, 3, 1, 0);
      },
    });

    const providers = await list(client);

    expect(byId(providers, 'claude').limits).toMatchObject({
      fiveHour: { usedPercent: 58 },
      week: { usedPercent: 41 },
    });
    expect(byId(providers, 'glm').limits).toMatchObject({ fiveHour: { usedPercent: 3 } });
    // Логов Codex в песочнице нет: данных нет — null, а не отсутствие поля.
    expect(byId(providers, 'codex').limits).toBeNull();
  });

  it('файл изменился — клиент получает providers.limitsChanged; пока не менялся — событий нет', async () => {
    let paths: { workDir: string; claude: string; glm: string } | undefined;
    const client = await boot({
      limits: { intervalMs: 40 },
      prepare: async (home) => {
        paths = await prepareWork(home);
        await putLimits(paths.workDir, paths.claude, 58, 41);
      },
    });
    await list(client);

    // Опрос идёт каждые 40 мс, а файл прежний: между двумя ответами на запросы событий нет.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const id = nextId;
    nextId += 1;
    client.send({ id, method: 'providers.list', params: {} });
    const quiet = await untilResponse(client, id);
    expect(quiet.filter((message) => message.event !== undefined)).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await putLimits((paths as { workDir: string }).workDir, (paths as { claude: string }).claude, 64, 41);
    const deadline = Date.now() + 5000;
    let changed: RawMessage | undefined;
    while (changed === undefined && Date.now() < deadline) {
      const message = await Promise.race([
        client.next(),
        new Promise<RawMessage>((resolve) => setTimeout(() => resolve({}), 200)),
      ]);
      if (message.event === 'providers.limitsChanged') changed = message;
    }
    expect(changed?.data).toMatchObject({ id: 'claude', limits: { fiveHour: { usedPercent: 64 } } });
  });
});
