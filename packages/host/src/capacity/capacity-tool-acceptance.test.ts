/**
 * Сверка чисел ёмкости на настоящем `startHost` (спека 2026-10-30, 4.3 и 7; план 3, задача 6). Окно (`capacity.get` по сокету
 * хоста) и агент (`get_capacity` через `POST /agent/tools` со своим токеном) читают один снимок `CapacityFeed`; тест
 * проверяет, что это так и в собранном хосте: вместо `claude` стоит `test/stub-agent.mjs`, потолок и давление заданы
 * рычагами окружения, сессии создаются через сокет, как это делает окно.
 *
 * Потолок 1 и четыре сессии человека: первая стартует, вторая и третья идут сверх потолка (запуски человека, не больше
 * двух), четвёртая встаёт в очередь. Это и есть «живых 3 из 1, в очереди 1».
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT_TOOLS_PATH, createWork } from '@parley/core';
import type { CapacitySnapshot, SessionRef } from '@parley/protocol';
import { connectRaw, hello, removeHome, tempHome, waitConnected } from '../../test/helpers.js';
import type { RawMessage, TestClient } from '../../test/helpers.js';
import { startHost } from '../host.js';
import type { RunningHost } from '../host.js';
import { hostPaths } from '../paths.js';

const STUB = fileURLToPath(new URL('../../test/stub-agent.mjs', import.meta.url));

/** Переменные, которые тест задаёт сам; прежние значения возвращаются после каждого теста. */
const ENV_KEYS = ['PARLEY_MACHINE_CONCURRENT', 'PARLEY_MEMORY_PRESSURE_FILE', 'PARLEY_CLAUDE_BIN', 'STUB_ARGS_FILE'] as const;
const savedEnv = new Map<string, string | undefined>();

let hosts: RunningHost[] = [];
let homes: string[] = [];
let dirs: string[] = [];

afterEach(async () => {
  await Promise.all(hosts.map((host) => host.context.shutdown('test-cleanup').catch(() => {})));
  hosts = [];
  for (const key of ENV_KEYS) {
    const before = savedEnv.get(key);
    if (before === undefined) delete process.env[key];
    else process.env[key] = before;
  }
  savedEnv.clear();
  await Promise.all(homes.map((home) => removeHome(home)));
  homes = [];
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs = [];
});

function setEnv(key: (typeof ENV_KEYS)[number], value: string): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  process.env[key] = value;
}

/** Ответ на запрос с этим номером; рассылки хоста по дороге откладываются в `events`. */
async function responseTo(client: TestClient, id: number, events: RawMessage[]): Promise<RawMessage> {
  for (;;) {
    const message = await client.next();
    if (message.id === id) return message;
    if (message.event !== undefined) events.push(message);
  }
}

/**
 * Что `get_capacity` должен сказать о машине, если окно показывает `machine`. Одно отображение вместо второй копии
 * чисел: тест утверждает «те же числа», а не «два одинаковых литерала».
 */
function toolMachineOf(machine: CapacitySnapshot['machine']): Record<string, unknown> {
  return {
    live: `${machine.live}/${machine.limit ?? 'off'}`,
    queued: machine.queued,
    memory: machine.pressure,
    swapGb: machine.swapGb,
    sleepAfterMin: machine.sleepMinutes,
  };
}

describe('хост: числа окна и инструмента get_capacity совпадают (спека ёмкости 4.3)', () => {
  it('потолок 1, давление warn, четыре сессии человека: capacity.get и get_capacity одной сессии дают одни числа, а смена давления доходит событием', async () => {
    const home = await tempHome();
    homes.push(home);
    const project = await mkdtemp(path.join(tmpdir(), 'parley-capacity-tool-'));
    dirs.push(project);
    const pressureFile = path.join(project, 'pressure');
    await writeFile(pressureFile, 'warn');
    const argsFile = path.join(project, 'args.json');
    setEnv('PARLEY_MACHINE_CONCURRENT', '1');
    setEnv('PARLEY_MEMORY_PRESSURE_FILE', pressureFile);
    setEnv('PARLEY_CLAUDE_BIN', STUB);
    setEnv('STUB_ARGS_FILE', argsFile);

    const running = await startHost({ home });
    hosts.push(running);
    const hostToken = await readFile(hostPaths(home).token, 'utf8');
    const map = await createWork(project, { title: 'Работа' });
    const client = connectRaw(hostPaths(home).socket);
    await waitConnected(client.socket);
    await hello(client, hostToken, { client: 'desktop' });

    const events: RawMessage[] = [];
    let nextId = 900;
    const call = async (method: string, params: unknown): Promise<unknown> => {
      nextId += 1;
      client.send({ id: nextId, method, params });
      const response = await responseTo(client, nextId, events);
      expect(response.error).toBeUndefined();
      return response.result;
    };
    const create = async (label: string): Promise<SessionRef> =>
      ((await call('sessions.create', { projectPath: project, workId: map.work.id, provider: 'claude', label, task: '', parent: null })) as { ref: SessionRef }).ref;

    // Первая сессия — раньше остальных: заглушка пишет argv в общий файл, и токен нужен именно её.
    await create('Первая');
    let argv: string[] = [];
    await vi.waitFor(async () => {
      argv = (JSON.parse(await readFile(argsFile, 'utf8')) as { argv: string[] }).argv;
    }, { timeout: 10_000, interval: 20 });
    const config = JSON.parse(await readFile(argv[argv.indexOf('--mcp-config') + 1] as string, 'utf8')) as {
      mcpServers: { parley: { env: Record<string, string> } };
    };
    const { PARLEY_AGENT_URL: agentUrl, PARLEY_AGENT_TOKEN: agentToken } = config.mcpServers.parley.env;
    const toolsUrl = new URL(AGENT_TOOLS_PATH, agentUrl);

    await create('Вторая');
    await create('Третья');
    const fourth = await create('Четвёртая');

    // Три процесса заглушки живы (один по потолку, два сверх него), четвёртая сессия ждёт в очереди.
    const windowSnapshot = async (): Promise<CapacitySnapshot> => (await call('capacity.get', {})) as CapacitySnapshot;
    let snapshot = await windowSnapshot();
    await vi.waitFor(async () => {
      snapshot = await windowSnapshot();
      expect(snapshot.machine.live).toBe(3);
      expect(snapshot.queue).toHaveLength(1);
    }, { timeout: 20_000, interval: 100 });
    expect(snapshot.machine).toEqual({ live: 3, limit: 1, queued: 1, pressure: 'warn', swapGb: null, sleepMinutes: null });
    expect(snapshot.queue[0]?.ref.sessionId).toBe(fourth.sessionId);

    // `get_capacity` первой сессии по её токену.
    const toolResult = async (): Promise<Record<string, unknown>> => {
      const response = await fetch(toolsUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${agentToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: 'call', launch: {}, name: 'get_capacity', args: {}, callId: randomUUID() }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { result: { content: { text: string }[] } };
      return JSON.parse((body.result.content[0] as { text: string }).text) as Record<string, unknown>;
    };
    const report = await toolResult();
    expect(report['machine']).toEqual(toolMachineOf(snapshot.machine));
    expect(report['machine']).toMatchObject({ live: '3/1', queued: 1, memory: 'warn', sleepAfterMin: null });
    expect(report['canStart']).toBe(0);
    expect(report['limitedBy']).toBe('queue');
    expect(report['hint']).toBe('Launches are waiting for a slot (1): new sessions queue behind them.');

    // Давление в файле стало `normal`: датчик читает раз в 10 с, и окно получает `capacity.changed` с новым уровнем.
    await writeFile(pressureFile, 'normal');
    const deadline = Date.now() + 25_000;
    let changed: CapacitySnapshot | undefined;
    const seen = (): CapacitySnapshot | undefined =>
      events
        .filter((message) => message.event === 'capacity.changed')
        .map((message) => message.data as CapacitySnapshot)
        .find((data) => data.machine.pressure === 'normal');
    while ((changed = seen()) === undefined && Date.now() < deadline) {
      const message = await Promise.race([
        client.next(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()))),
      ]);
      if (message?.event !== undefined) events.push(message);
    }
    expect(changed, 'capacity.changed с pressure normal за 25 с').toBeDefined();
    // Слота под потолком по-прежнему нет, четвёртая сессия в очереди.
    expect(changed?.machine).toMatchObject({ live: 3, limit: 1, queued: 1, pressure: 'normal' });
    expect(changed?.queue.map((entry) => entry.ref.sessionId)).toEqual([fourth.sessionId]);
    client.close();
  }, 90_000);
});
