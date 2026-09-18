import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MCP_SERVER_ENTRY,
  MCP_SERVER_NAME,
  codexMcpOverride,
  mcpConfig,
  mcpConfigJson,
  mcpConfigValue,
  writeMcpConfig,
} from './mcp-config.js';
import { createWork } from './store.js';

const params = { workDir: '/project/.harnas/works/w-0042', sessionId: 's-02' };

describe('конфиг MCP-сервера на сессию', () => {
  it('описывает один stdio-сервер по абсолютному пути с окружением сессии', () => {
    // Bin `harnas-mcp` есть в PATH только под pnpm; агент стартует откуда угодно,
    // поэтому сервер задаётся node текущего процесса и абсолютным путём к скрипту.
    expect(path.isAbsolute(MCP_SERVER_ENTRY)).toBe(true);
    expect(MCP_SERVER_ENTRY.endsWith(path.join('mcp', 'server.js'))).toBe(true);
    expect(mcpConfig(params)).toEqual({
      mcpServers: {
        [MCP_SERVER_NAME]: {
          type: 'stdio',
          command: process.execPath,
          args: [MCP_SERVER_ENTRY],
          env: {
            HARNAS_WORK_DIR: '/project/.harnas/works/w-0042',
            HARNAS_SESSION_ID: 's-02',
          },
        },
      },
    });
  });

  it('бинарь сервера переопределяется: установка бывает не только из PATH', () => {
    const config = mcpConfig({ ...params, command: '/opt/harnas/harnas-mcp' });
    expect(config.mcpServers[MCP_SERVER_NAME]?.command).toBe('/opt/harnas/harnas-mcp');
    expect(config.mcpServers[MCP_SERVER_NAME]?.args).toEqual([]);
  });

  it('при push сервер получает HARNAS_CHANNEL: без него сторож входящих спит', () => {
    expect(mcpConfig({ ...params, channel: true }).mcpServers[MCP_SERVER_NAME]?.env).toEqual({
      HARNAS_WORK_DIR: '/project/.harnas/works/w-0042',
      HARNAS_SESSION_ID: 's-02',
      HARNAS_CHANNEL: '1',
    });
    // Без push переменной нет вовсе: сервер не объявляет channel и не звонит.
    expect(mcpConfig(params).mcpServers[MCP_SERVER_NAME]?.env).not.toHaveProperty('HARNAS_CHANNEL');
  });

  it('JSON разбирается обратно в тот же конфиг', () => {
    expect(JSON.parse(mcpConfigJson(params))).toEqual(mcpConfig(params));
  });

  it('codex получает тот же сервер инлайн-таблицей TOML для -c', () => {
    expect(codexMcpOverride(params)).toBe(
      `mcp_servers.harnas={command=${JSON.stringify(process.execPath)},` +
        `args=[${JSON.stringify(MCP_SERVER_ENTRY)}],` +
        'env={HARNAS_WORK_DIR="/project/.harnas/works/w-0042",HARNAS_SESSION_ID="s-02"}}',
    );
  });

  it('codex звонка не получает: push — возможность Claude Code (4.4)', () => {
    expect(codexMcpOverride({ ...params, channel: true })).toBe(codexMcpOverride(params));
  });

  it('кавычки в пути экранируются, а не рвут TOML', () => {
    expect(codexMcpOverride({ ...params, command: '/opt/a"b/harnas-mcp' })).toContain(
      'command="/opt/a\\"b/harnas-mcp"',
    );
  });
});

describe('mcpConfigValue', () => {
  it('json-file подставляет путь к файлу, codex-override — переопределение', () => {
    expect(mcpConfigValue('json-file', params, '/tmp/s-02.json')).toBe('/tmp/s-02.json');
    expect(mcpConfigValue('codex-override', params, '/tmp/s-02.json')).toBe(
      codexMcpOverride(params),
    );
  });

  it('провайдер без поддержки MCP не получает подстановки вовсе', () => {
    expect(mcpConfigValue(undefined, params, '/tmp/s-02.json')).toBeUndefined();
  });
});

describe('writeMcpConfig', () => {
  let home = '';
  let project = '';

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'harnas-home-'));
    project = await mkdtemp(path.join(tmpdir(), 'harnas-project-'));
    process.env.HARNAS_HOME = home;
  });

  afterEach(async () => {
    delete process.env.HARNAS_HOME;
    await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('кладёт конфиг в mcp/<session-id>.json внутри работы', async () => {
    await createWork(project, { title: 'Авторизация' });
    const file = await writeMcpConfig(project, 'w-0001', 's-01');

    expect(file).toBe(path.join(project, '.harnas', 'works', 'w-0001', 'mcp', 's-01.json'));
    const written = JSON.parse(await readFile(file, 'utf8')) as ReturnType<typeof mcpConfig>;
    // Каталог работы сервер получает абсолютным — он же его рабочая директория.
    expect(written.mcpServers[MCP_SERVER_NAME]?.env['HARNAS_WORK_DIR']).toBe(
      path.join(project, '.harnas', 'works', 'w-0001'),
    );
    expect(written.mcpServers[MCP_SERVER_NAME]?.env['HARNAS_SESSION_ID']).toBe('s-01');
    expect(written.mcpServers[MCP_SERVER_NAME]?.env).not.toHaveProperty('HARNAS_CHANNEL');
  });

  it('с включённым push кладёт в конфиг HARNAS_CHANNEL', async () => {
    await createWork(project, { title: 'Авторизация' });
    const file = await writeMcpConfig(project, 'w-0001', 's-01', undefined, true);

    const written = JSON.parse(await readFile(file, 'utf8')) as ReturnType<typeof mcpConfig>;
    expect(written.mcpServers[MCP_SERVER_NAME]?.env['HARNAS_CHANNEL']).toBe('1');
  });
});
