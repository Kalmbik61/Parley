/**
 * Монтирование `/agent/tools` в настоящем хосте (спека хранилища 6.3, 6.5). `tools-endpoint.test.ts` проверяет сам маршрут
 * на отдельном сервере, а здесь — что `startHost` его подключил: сессию запускает настоящий хост (вместо claude —
 * заглушка), токен и адрес берутся из конфига MCP этой сессии, как их берёт parley-mcp. Не смонтированный маршрут отвечает
 * 404 приёмника хуков, а клиент читает 404 как «хост прежней сборки» и навсегда уходит на прямое чтение карты: все
 * остальные тесты остались бы зелёными, а весь этап — молча выключенным.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT_TOOLS_PATH, createWork } from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import { connectRaw, hello, removeHome, tempHome, waitConnected } from '../../test/helpers.js';
import type { RawMessage, TestClient } from '../../test/helpers.js';
import { startHost } from '../host.js';
import type { RunningHost } from '../host.js';
import { hostPaths } from '../paths.js';

const STUB = fileURLToPath(new URL('../../test/stub-agent.mjs', import.meta.url));

let hosts: RunningHost[] = [];
let homes: string[] = [];
let projects: string[] = [];

afterEach(async () => {
  await Promise.all(hosts.map((host) => host.context.shutdown('test-cleanup').catch(() => {})));
  hosts = [];
  await Promise.all(homes.map((home) => removeHome(home)));
  homes = [];
  await Promise.all(projects.map((dir) => rm(dir, { recursive: true, force: true })));
  projects = [];
});

/** Ответ на запрос с этим номером; рассылки хоста по дороге пропускаются. */
async function responseTo(client: TestClient, id: number): Promise<RawMessage> {
  for (;;) {
    const message = await client.next();
    if (message.id === id) return message;
  }
}

describe('хост: маршрут /agent/tools смонтирован (спека хранилища 6.3)', () => {
  it('сессия, запущенная хостом, ходит со своим токеном на /agent/tools: list и get_map отвечают 200 и ok: true, а после остановки сессии токен — 401', async () => {
    const home = await tempHome();
    homes.push(home);
    const running = await startHost({ home });
    hosts.push(running);
    const hostToken = await readFile(hostPaths(home).token, 'utf8');
    const project = await mkdtemp(path.join(tmpdir(), 'parley-tools-wiring-'));
    projects.push(project);
    const argsFile = path.join(project, 'args.json');
    process.env['PARLEY_CLAUDE_BIN'] = STUB;
    process.env['STUB_ARGS_FILE'] = argsFile;
    try {
      const map = await createWork(project, { title: 'Работа' });
      const client = connectRaw(hostPaths(home).socket);
      await waitConnected(client.socket);
      await hello(client, hostToken, { client: 'desktop' });
      client.send({ id: 901, method: 'sessions.create', params: { projectPath: project, workId: map.work.id, provider: 'claude', label: 'агент', task: '', parent: null } });
      const created = await responseTo(client, 901);
      expect(created.error).toBeUndefined();
      const ref = (created.result as { ref: SessionRef }).ref;

      // Адрес и токен — из конфига MCP-сервера сессии: тот же путь, которым их получает настоящий parley-mcp.
      let argv: string[] = [];
      await vi.waitFor(async () => {
        argv = (JSON.parse(await readFile(argsFile, 'utf8')) as { argv: string[] }).argv;
      }, { timeout: 10_000, interval: 20 });
      const config = JSON.parse(await readFile(argv[argv.indexOf('--mcp-config') + 1] as string, 'utf8')) as {
        mcpServers: { parley: { env: Record<string, string> } };
      };
      const { PARLEY_AGENT_URL: agentUrl, PARLEY_AGENT_TOKEN: agentToken } = config.mcpServers.parley.env;
      const toolsUrl = new URL(AGENT_TOOLS_PATH, agentUrl);
      const post = async (body: unknown): Promise<{ status: number; json: unknown }> => {
        const response = await fetch(toolsUrl, {
          method: 'POST',
          headers: { Authorization: `Bearer ${agentToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const text = await response.text();
        return { status: response.status, json: text === '' ? null : (JSON.parse(text) as unknown) };
      };

      // `list`: ответ маршрута, а не 404 приёмника хуков.
      const listed = await post({ op: 'list', launch: {} });
      expect(listed.status).toBe(200);
      expect(listed.json).toMatchObject({ ok: true, result: { tools: expect.arrayContaining([expect.objectContaining({ name: 'get_map' })]) as unknown } });

      // `get_map`: сессию называет токен; строки провайдеров — свои у хоста (запасной путь с пометкой «host unreachable» не взят).
      const got = await post({ op: 'call', launch: {}, name: 'get_map', args: {}, callId: randomUUID() });
      expect(got.status).toBe(200);
      const text = ((got.json as { result: { content: { text: string }[] } }).result.content[0] as { text: string }).text;
      const view = JSON.parse(text) as { sessionId: string; providers: { id: string }[]; note?: string };
      expect(view.sessionId).toBe(ref.sessionId);
      expect(view.providers.map((provider) => provider.id)).toContain('claude');
      expect(view).not.toHaveProperty('note');

      // Сессия остановлена — токен снят, маршрут отвечает 401.
      client.send({ id: 902, method: 'sessions.stop', params: { ref } });
      await responseTo(client, 902);
      await vi.waitFor(async () => expect((await post({ op: 'list', launch: {} })).status).toBe(401), { timeout: 10_000, interval: 50 });
      client.close();
    } finally {
      delete process.env['PARLEY_CLAUDE_BIN'];
      delete process.env['STUB_ARGS_FILE'];
    }
  }, 30_000);
});
