import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { connectRaw, hello, removeHome, tempHome, waitConnected } from '../../test/helpers.js';
import type { RawMessage, TestClient } from '../../test/helpers.js';
import { startHost } from '../host.js';
import type { RunningHost } from '../host.js';
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
}

/**
 * Хост с подменённой пробой версий. Настоящие claude и codex не запускаются: `probeVersion`
 * — подмена, а `startHost` без неё ничего не пробует.
 */
async function boot(
  options: { probeVersion?: (command: string) => Promise<string | null>; providersJson?: unknown } = {},
): Promise<TestClient> {
  const home = await tempHome();
  homes.push(home);
  if (options.providersJson !== undefined) {
    await writeFile(path.join(home, 'providers.json'), JSON.stringify(options.providersJson), 'utf8');
  }
  const running = await startHost({
    home,
    ...(options.probeVersion === undefined ? {} : { probeVersion: options.probeVersion }),
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
