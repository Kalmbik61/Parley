import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROVIDERS, addSession, createWork, selectableModels, updateMap, workPaths } from '@parley/core';
import { connectRaw, hello, removeHome, tempHome, waitConnected } from '../../test/helpers.js';
import type { RawMessage, TestClient } from '../../test/helpers.js';
import type { RequestInfo } from '../context.js';
import { startHost } from '../host.js';
import type { HostOptions, RunningHost } from '../host.js';
import { hostPaths } from '../paths.js';
import { createProvidersList } from './providers.js';

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
  models: Array<{ id: string; label: string; efforts?: Array<{ id: string; label: string; description?: string }> | null }> | null;
  effort: boolean;
  argsOverridden?: boolean;
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
    /** Подмена пробы каталога Codex (`codex debug models`); без неё каталога нет. */
    probeCodexCatalog?: (command: string) => Promise<string | null>;
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
    ...(options.probeCodexCatalog === undefined ? {} : { probeCodexCatalog: options.probeCodexCatalog }),
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
  it('claude, codex и glm принимают effort; GLM использует версию Claude Code', async () => {
    process.env['PARLEY_CLAUDE_BIN'] = process.execPath;
    extraEnv.push('PARLEY_CLAUDE_BIN');
    const client = await boot({
      probeVersion: async (command) => (command === 'claude' ? '2.1.276' : command === 'codex' ? '0.44.0' : null),
    });
    const providers = await list(client);

    expect(byId(providers, 'claude')).toMatchObject({ label: 'Claude', effort: true, version: '2.1.276' });
    expect(byId(providers, 'codex')).toMatchObject({ label: 'Codex', effort: true, version: '0.44.0' });
    expect(byId(providers, 'glm')).toMatchObject({ label: 'GLM', effort: true, version: '2.1.276', available: false });
    expect(byId(providers, 'glm').models?.length).toBeGreaterThan(0);
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

  it('обычные версии кэшируются; GLM заново проверяет версию Claude Code при каждом list', async () => {
    process.env['PARLEY_CLAUDE_BIN'] = process.execPath;
    extraEnv.push('PARLEY_CLAUDE_BIN');
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
    expect(calls.sort()).toEqual(['claude', 'claude', 'claude', 'claude', 'codex']);
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

  it('окну уходят списки реестра: claude — алиасы, codex — запасной список; порядок, подписи и уровни как в реестре', async () => {
    const providers = await list(await boot());
    /** Пары id и подпись; уровни сверяются ниже, отдельно. */
    const pairsOf = (id: string) => byId(providers, id).models?.map((model) => ({ id: model.id, label: model.label }));

    expect(pairsOf('claude')).toEqual([
      { id: 'best', label: 'Best' },
      { id: 'fable', label: 'Fable' },
      { id: 'sonnet', label: 'Sonnet' },
      { id: 'opus', label: 'Opus' },
      { id: 'haiku', label: 'Haiku' },
      { id: 'sonnet[1m]', label: 'Sonnet (1M context)' },
      { id: 'opus[1m]', label: 'Opus (1M context)' },
      { id: 'opusplan', label: 'Opus Plan' },
      { id: 'opusplan[1m]', label: 'Opus Plan (1M context)' },
    ]);
    expect(pairsOf('codex')).toEqual([
      { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' },
      { id: 'gpt-6-astra', label: 'GPT-6-Astra' },
      { id: 'gpt-6-sol', label: 'GPT-6-Sol' },
      { id: 'gpt-6-luna', label: 'GPT-6-Luna' },
      { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
      { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra' },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' },
    ]);
    // Уровни едут по проводу вместе с моделью: у Haiku их нет, у Luna нет Ultra.
    const levelsOf = (provider: string, model: string) =>
      byId(providers, provider).models?.find((option) => option.id === model)?.efforts;
    expect(levelsOf('claude', 'haiku')).toBeNull();
    expect(levelsOf('codex', 'gpt-6-luna')?.map((level) => level.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('свой список моделей из providers.json заменяет встроенный, если шаблон запуска принимает модель', async () => {
    const providers = await list(
      await boot({
        providersJson: {
          codex: { models: [{ id: 'my-new-model', label: 'Моя новая' }] },
          // Свой провайдер без {model} в шаблоне: список окну не нужен — модель до команды не доедет.
          opencode: {
            badge: 'OpenCode',
            command: 'opencode',
            args: ['{prompt}'],
            models: [{ id: 'a', label: 'А' }],
          },
          // …а с {model} и {effort} в шаблоне провайдер их принимает.
          smart: {
            badge: 'Smart',
            command: 'smart',
            args: ['--m', '{model}', '--e', '{effort}'],
            models: [{ id: 'fast', label: 'Быстрая' }],
          },
          // Пустой список убирает встроенный: у claude списка больше нет.
          claude: { models: [] },
        },
      }),
    );

    expect(byId(providers, 'codex').models).toEqual([{ id: 'my-new-model', label: 'Моя новая' }]);
    expect(byId(providers, 'opencode')).toMatchObject({ models: null, effort: false });
    expect(byId(providers, 'smart')).toMatchObject({ models: [{ id: 'fast', label: 'Быстрая' }], effort: true });
    expect(byId(providers, 'claude').models).toBeNull();
  });

  it('available: команда есть в PATH или подменена оверрайдом — как и прежде', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'parley-providers-bin-'));
    const file = path.join(dir, 'claude-stub');
    await writeFile(file, '#!/bin/sh\n', 'utf8');
    await chmod(file, 0o755);
    process.env['PARLEY_CLAUDE_BIN'] = file;
    process.env['PARLEY_CODEX_BIN'] = path.join(dir, 'нет-такого');
    extraEnv.push('PARLEY_CLAUDE_BIN', 'PARLEY_CODEX_BIN');

    const providers = await list(await boot());
    expect(byId(providers, 'claude').available).toBe(true);
    expect(byId(providers, 'codex').available).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('sessions.create по проводу: модель вне списка провайдера — bad_request (дизайн комнат, 3.2)', () => {
  /** `sessions.create` с несуществующим проектом: отказ по модели идёт раньше любой записи на диск. */
  async function create(client: TestClient, provider: string, model: string): Promise<RawMessage> {
    const id = nextId;
    nextId += 1;
    client.send({
      id,
      method: 'sessions.create',
      params: { projectPath: '/не/существует', workId: null, provider, label: '', task: '', parent: null, model },
    });
    for (;;) {
      const message: RawMessage = await client.next();
      if (message.id === id) return message;
    }
  }

  it('значение чужого списка и значение вне списка отвергаются, ответ называет провайдера и допустимое', async () => {
    const client = await boot();

    const wrongProvider = await create(client, 'claude', 'gpt-6-sol');
    expect(wrongProvider.error?.code).toBe('bad_request');
    expect(wrongProvider.error?.message).toContain('claude');
    expect(wrongProvider.error?.message).toContain('opusplan');
    expect((await create(client, 'codex', 'opus')).error?.code).toBe('bad_request');
  });

  it('вид значения проверяет схема раньше хоста: с дефисом впереди — bad_request и без списка провайдера', async () => {
    const client = await boot();

    expect((await create(client, 'glm', '--dangerously-skip-permissions')).error?.code).toBe('bad_request');
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
    const project = await mkdtemp(path.join(tmpdir(), 'parley-providers-limits-'));
    projects.push(project);
    process.env['PARLEY_HOME'] = home;
    try {
      const created = await createWork(project, { title: 'Лимиты' });
      const map = await updateMap(project, created.work.id, (draft) => {
        addSession(draft, { provider: 'claude', label: 'один', task: 'задача' });
        addSession(draft, { provider: 'glm', label: 'два', task: 'задача' });
      });
      const [claude, glm] = map.sessions.map((session) => session.id);
      return { workDir: workPaths(project, created.work.id).dir, claude: claude as string, glm: glm as string };
    } finally {
      delete process.env['PARLEY_HOME'];
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

  /** Ближайшее событие `name`; не пришло за пять секунд — ошибка. Ожидание одно, брошенных нет. */
  async function eventNamed(client: TestClient, name: string): Promise<RawMessage> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`событие ${name} не пришло за 5 с`)), 5000);
    });
    try {
      for (;;) {
        const message = await Promise.race([client.next(), timeout]);
        if (message.event === name) return message;
      }
    } finally {
      clearTimeout(timer);
    }
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
    expect(byId(providers, 'glm').limits).toBeNull();
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

    // Опрос идёт каждые 40 мс, а файл прежний: между двумя ответами на запросы событий лимитов нет.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const id = nextId;
    nextId += 1;
    client.send({ id, method: 'providers.list', params: {} });
    const quiet = await untilResponse(client, id);
    expect(quiet.filter((message) => message.event === 'providers.limitsChanged')).toEqual([]);

    const { workDir, claude } = paths as { workDir: string; claude: string };
    await putLimits(workDir, claude, 64, 41);
    const changed = await eventNamed(client, 'providers.limitsChanged');
    expect(changed.data).toMatchObject({ id: 'claude', limits: { fiveHour: { usedPercent: 64 } } });
  });
});

describe('providers.list: каталог Codex от CLI и argsOverridden (спека нормалайзера, 5.2, 5.6)', () => {
  /** Урезанный вывод `codex debug models`: модель, которой нет во встроенном списке, и одна из него. */
  const LIVE_CATALOG = JSON.stringify({
    models: [
      {
        slug: 'gpt-6.1-sol',
        display_name: 'GPT-6.1-Sol',
        visibility: 'list',
        priority: 1,
        supported_reasoning_levels: [
          { effort: 'low', description: 'Fast responses with lighter reasoning' },
          { effort: 'ultra', description: 'Maximum reasoning with automatic task delegation' },
        ],
      },
      {
        slug: 'gpt-7-nova',
        display_name: 'GPT-7-Nova',
        visibility: 'list',
        priority: 0,
        supported_reasoning_levels: [
          { effort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
        ],
      },
    ],
  });

  /** Проба каталога, которая отвечает, только когда тест разрешит: до того список — встроенный. */
  function gatedProbe(): {
    calls: string[];
    probe: (command: string) => Promise<string | null>;
    answer: (stdout: string | null) => void;
  } {
    const calls: string[] = [];
    let release: (stdout: string | null) => void = () => {};
    return {
      calls,
      probe: (command) => {
        calls.push(command);
        return new Promise((resolve) => {
          release = resolve;
        });
      },
      answer: (stdout) => release(stdout),
    };
  }

  /** Ближайшее `providers.changed`, прочие сообщения пропускаются; не пришло за 5 с — ошибка. */
  async function providersChanged(client: TestClient): Promise<RawMessage> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('событие providers.changed не пришло за 5 с')), 5000);
    });
    try {
      for (;;) {
        const message = await Promise.race([client.next(), timeout]);
        if (message.event === 'providers.changed') return message;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  it('сначала встроенный список; после пробы — providers.changed и каталог CLI в порядке Codex с уровнями', async () => {
    const gate = gatedProbe();
    const client = await boot({ probeCodexCatalog: gate.probe });
    expect(byId(await list(client), 'codex').models).toEqual(selectableModels(PROVIDERS.codex));

    await vi.waitFor(() => expect(gate.calls).toEqual(['codex']));
    gate.answer(LIVE_CATALOG);
    expect((await providersChanged(client)).data).toEqual({ provider: 'codex' });

    const providers = await list(client);
    expect(byId(providers, 'codex').models).toEqual([
      {
        id: 'gpt-7-nova',
        label: 'GPT-7-Nova',
        efforts: [{ id: 'medium', label: 'Medium', description: 'Balances speed and reasoning depth for everyday tasks' }],
      },
      {
        id: 'gpt-6.1-sol',
        label: 'GPT-6.1-Sol',
        efforts: [
          { id: 'low', label: 'Low', description: 'Fast responses with lighter reasoning' },
          { id: 'ultra', label: 'Ultra', description: 'Maximum reasoning with automatic task delegation' },
        ],
      },
    ]);
    // Каталог Codex — только у codex.
    expect(byId(providers, 'claude').models).toEqual(selectableModels(PROVIDERS.claude));
  });

  it('свой список codex из providers.json важнее каталога CLI', async () => {
    const gate = gatedProbe();
    const client = await boot({
      probeCodexCatalog: gate.probe,
      providersJson: { codex: { models: [{ id: 'my-codex', label: 'Мой' }] } },
    });
    await vi.waitFor(() => expect(gate.calls).toEqual(['codex']));
    gate.answer(LIVE_CATALOG);
    await providersChanged(client);

    expect(byId(await list(client), 'codex').models).toEqual([{ id: 'my-codex', label: 'Мой' }]);
  });

  it('argsOverridden: args провайдера из providers.json — окно объяснит пропавший выбор', async () => {
    const providers = await list(await boot({ providersJson: { codex: { args: ['{prompt}'] } } }));

    expect(byId(providers, 'codex')).toMatchObject({ argsOverridden: true, models: null, effort: false });
    expect(byId(providers, 'claude')).toMatchObject({ argsOverridden: false });
  });

  it('каждый providers.list просит каталог обновиться, если он устарел; ответ пробу не ждёт', async () => {
    const refreshIfStale = vi.fn();
    const handler = createProvidersList(undefined, undefined, undefined, { refreshIfStale });

    await handler({}, {} as RequestInfo);
    await handler({}, {} as RequestInfo);

    expect(refreshIfStale).toHaveBeenCalledTimes(2);
  });
});
