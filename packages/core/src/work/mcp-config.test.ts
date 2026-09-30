import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseTomlAssignment, parseTomlValue, type TomlValue } from '../../test/toml-mini.js';
import { MAX_TIMEOUT_SEC } from '../mcp/tools.js';
import { CODEX_NOTIFY_ENTRY } from './codex-notify.js';
import {
  CODEX_MCP_STARTUP_TIMEOUT_SEC,
  CODEX_MCP_TOOL_TIMEOUT_SEC,
  MCP_SERVER_ENTRY,
  MCP_SERVER_NAME,
  codexMcpOverride,
  codexNotifyOverride,
  mcpConfig,
  mcpConfigJson,
  mcpConfigValue,
  tomlString,
  writeMcpConfig,
} from './mcp-config.js';
import { createWork } from './store.js';

const params = { workDir: '/project/.harnas/works/w-0042', sessionId: 's-02' };

describe('конфиг MCP-сервера на сессию', () => {
  it('описывает один stdio-сервер по абсолютному пути с окружением сессии', () => {
    // Bin `parley-mcp` есть в PATH только под pnpm; агент стартует откуда угодно,
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
    const config = mcpConfig({ ...params, command: '/opt/parley/parley-mcp' });
    expect(config.mcpServers[MCP_SERVER_NAME]?.command).toBe('/opt/parley/parley-mcp');
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
        'env={HARNAS_WORK_DIR="/project/.harnas/works/w-0042",HARNAS_SESSION_ID="s-02"},' +
        `startup_timeout_sec=${CODEX_MCP_STARTUP_TIMEOUT_SEC},tool_timeout_sec=${CODEX_MCP_TOOL_TIMEOUT_SEC}}`,
    );
  });

  it('таблица сервера — настоящий TOML: Codex не примет её за обычную строку', () => {
    const { key, value } = parseTomlAssignment(codexMcpOverride(params));
    expect(key).toEqual(['mcp_servers', 'harnas']);
    expect(value).toEqual({
      command: process.execPath,
      args: [MCP_SERVER_ENTRY],
      env: { HARNAS_WORK_DIR: '/project/.harnas/works/w-0042', HARNAS_SESSION_ID: 's-02' },
      startup_timeout_sec: CODEX_MCP_STARTUP_TIMEOUT_SEC,
      tool_timeout_sec: CODEX_MCP_TOOL_TIMEOUT_SEC,
    });
  });

  it('запуск сервера с запасом, а вызов — дольше самого долгого wait_for', () => {
    // По умолчанию Codex ждёт запуск сервера 10 с, а ответ инструмента — 60: `wait_for` живёт
    // до `MAX_TIMEOUT_SEC` и без запаса был бы оборван клиентом посреди ожидания.
    expect(CODEX_MCP_STARTUP_TIMEOUT_SEC).toBeGreaterThan(10);
    expect(CODEX_MCP_TOOL_TIMEOUT_SEC).toBeGreaterThan(MAX_TIMEOUT_SEC);
  });

  it('серверу, которому Codex режет окружение, уходят переменные HARNAS_* хоста', () => {
    // Сервер получает окружение урезанным (HOME, PATH и ещё несколько), а `HARNAS_HOME` и
    // подмены бинарей ему нужны: без них он читал бы чужой дом и искал не те команды.
    const env = {
      HARNAS_HOME: '/tmp/чужой дом',
      HARNAS_CODEX_BIN: '/opt/stub/codex',
      HARNAS_CLAUDE_PROJECTS_DIR: '/tmp/projects',
      // Свои две переменные сервера задаёт харнесс, унаследованные значения их не перекрывают.
      HARNAS_WORK_DIR: '/other/work',
      HARNAS_SESSION_ID: 's-99',
      HARNAS_CHANNEL: '1',
      PATH: '/usr/bin',
      HOME: '/Users/x',
      OPENAI_API_KEY: 'секрет',
    };
    const { value } = parseTomlAssignment(codexMcpOverride({ ...params, env }));
    const table = value as Record<string, TomlValue>;
    expect(table['env']).toEqual({
      HARNAS_WORK_DIR: '/project/.harnas/works/w-0042',
      HARNAS_SESSION_ID: 's-02',
      HARNAS_HOME: '/tmp/чужой дом',
      HARNAS_CODEX_BIN: '/opt/stub/codex',
      HARNAS_CLAUDE_PROJECTS_DIR: '/tmp/projects',
    });
  });

  it('переменные без префикса HARNAS_ и с чужими именами в таблицу не попадают', () => {
    const env = {
      HARNAS_OK: '1',
      HARNAS_плохое: '2',
      'HARNAS BAD': '3',
      harnas_low: '4',
      SECRET: '5',
    };
    const { value } = parseTomlAssignment(codexMcpOverride({ ...params, env }));
    expect((value as Record<string, TomlValue>)['env']).toEqual({
      HARNAS_WORK_DIR: '/project/.harnas/works/w-0042',
      HARNAS_SESSION_ID: 's-02',
      HARNAS_OK: '1',
    });
  });

  it('пустые и неопределённые HARNAS_* не отдаются', () => {
    const { value } = parseTomlAssignment(
      codexMcpOverride({ ...params, env: { HARNAS_EMPTY: '', HARNAS_UNSET: undefined } }),
    );
    expect((value as Record<string, TomlValue>)['env']).toEqual({
      HARNAS_WORK_DIR: '/project/.harnas/works/w-0042',
      HARNAS_SESSION_ID: 's-02',
    });
  });

  it('codex звонка не получает: push — возможность Claude Code (4.4)', () => {
    expect(codexMcpOverride({ ...params, channel: true })).toBe(codexMcpOverride(params));
  });

  it('кавычки в пути экранируются, а не рвут TOML', () => {
    expect(codexMcpOverride({ ...params, command: '/opt/a"b/parley-mcp' })).toContain(
      'command="/opt/a\\"b/parley-mcp"',
    );
  });
});

/** Значения, на которых наивная склейка строк ломает TOML: кавычки, `\`, юникод, управляющие знаки. */
const HOSTILE: ReadonlyArray<{ name: string; value: string; decoded?: string }> = [
  { name: 'кавычка', value: 'a"b' },
  { name: 'обратный слеш', value: 'C:\\Users\\x\\parley' },
  { name: 'слеш и кавычка подряд', value: 'a\\"b\\\\"' },
  { name: 'кириллица и пробелы', value: '/Users/иван/мой проект' },
  { name: 'астральный символ', value: '/tmp/😀/проект' },
  { name: 'составной эмодзи', value: '/tmp/👩‍💻/x' },
  { name: 'комбинирующий знак', value: '/tmp/e\u0301' },
  { name: 'перевод строки и табуляция', value: 'a\nb\tc\r\nd' },
  { name: 'NUL и прочие управляющие', value: 'a\u0000b\u0001c\u001fd' },
  { name: 'DEL', value: 'a\u007fb' },
  { name: 'C1-управляющий', value: 'a\u0085b' },
  { name: 'разделители строк Unicode', value: 'a\u2028b\u2029c' },
  // Одиночный суррогат в TOML — не скаляр: `\uD800` там ошибка, а не знак. Он заменяется на U+FFFD.
  { name: 'одиночный старший суррогат', value: 'a\ud83db', decoded: 'a\ufffdb' },
  { name: 'одиночный младший суррогат', value: 'a\ude00b', decoded: 'a\ufffdb' },
  { name: 'пустая строка', value: '' },
];

describe('tomlString — экранирование значений TOML для -c', () => {
  for (const { name, value, decoded } of HOSTILE) {
    it(`${name}: строка разбирается TOML-разборщиком обратно`, () => {
      expect(parseTomlValue(tomlString(value))).toBe(decoded ?? value);
    });
  }

  it('в теле строки нет ни сырых управляющих знаков, ни сырого DEL', () => {
    // eslint-disable-next-line no-control-regex
    const raw = /[\u0000-\u0008\u000a-\u001f\u007f]/;
    for (const { value } of HOSTILE) expect(tomlString(value)).not.toMatch(raw);
  });

  it('разборщик тестов сам строг: сырой DEL, суррогатный \\u и неизвестный escape — отказ', () => {
    expect(() => parseTomlValue('"a\u007fb"')).toThrow(/управляющий/);
    expect(() => parseTomlValue('"\\ud83d"')).toThrow(/скаляр/);
    expect(() => parseTomlValue('"\\/"')).toThrow(/неизвестный escape/);
    expect(() => parseTomlValue('{a="1",}')).toThrow();
  });

  it('опасные значения в путях и окружении сервера доезжают до Codex неизменными', () => {
    for (const { name, value, decoded } of HOSTILE) {
      if (value === '') continue;
      const expected = decoded ?? value;
      const override = codexMcpOverride({
        workDir: `/tmp/${value}/.harnas/works/w-0001`,
        sessionId: 's-01',
        command: `/opt/${value}/parley-mcp`,
        env: { HARNAS_HOME: value },
      });
      const table = parseTomlAssignment(override).value as Record<string, TomlValue>;
      expect(table['command'], name).toBe(`/opt/${expected}/parley-mcp`);
      expect((table['env'] as Record<string, TomlValue>)['HARNAS_WORK_DIR'], name).toBe(
        `/tmp/${expected}/.harnas/works/w-0001`,
      );
      expect((table['env'] as Record<string, TomlValue>)['HARNAS_HOME'], name).toBe(expected);
    }
  });
});

describe('codexNotifyOverride', () => {
  it('notify — массив из node и скрипта харнесса по абсолютным путям', () => {
    expect(path.isAbsolute(CODEX_NOTIFY_ENTRY)).toBe(true);
    expect(CODEX_NOTIFY_ENTRY.endsWith('codex-notify-bin.js')).toBe(true);
    const { key, value } = parseTomlAssignment(codexNotifyOverride());
    expect(key).toEqual(['notify']);
    expect(value).toEqual([process.execPath, CODEX_NOTIFY_ENTRY]);
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
    home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
    project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
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
