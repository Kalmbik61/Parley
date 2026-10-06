import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { workPaths } from './work/store.js';
import type { WorkIndexEntry, WorkMap, WorksIndex } from './work/types.js';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, 'cli.ts');
const REPO = path.join(here, '..', '..', '..');

let home = '';
let project = '';
let binDir = '';
let stub = '';

interface Result {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Тот же способ, что у остальных тестов CLI: исходник через tsx. Домашняя папка
 * харнесса и проект — временные, настоящий `claude` не запускается никогда:
 * доступность провайдеров подсунута оверрайдами на shell-заглушку.
 */
async function cli(...args: string[]): Promise<Result> {
  return cliEnv({}, ...args);
}

/** То же самое, но с добавкой к окружению: настройки харнесса читаются из него. */
async function cliEnv(extra: NodeJS.ProcessEnv, ...args: string[]): Promise<Result> {
  const env = {
    ...process.env,
    PARLEY_HOME: home,
    PARLEY_CLAUDE_BIN: stub,
    PARLEY_CODEX_BIN: stub,
    PARLEY_GLM_BIN: '',
    ...extra,
  };
  try {
    const { stdout, stderr } = await run('pnpm', ['exec', 'tsx', CLI, ...args], { cwd: REPO, env });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', code: failure.code ?? 1 };
  }
}

async function ok(...args: string[]): Promise<Record<string, unknown>> {
  return okEnv({}, ...args);
}

async function okEnv(extra: NodeJS.ProcessEnv, ...args: string[]): Promise<Record<string, unknown>> {
  const result = await cliEnv(extra, ...args);
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

const readMapFile = async (workId: string): Promise<WorkMap> =>
  JSON.parse(await readFile(workPaths(project, workId).map, 'utf8')) as WorkMap;

const readIndexFile = async (): Promise<WorksIndex> =>
  JSON.parse(await readFile(path.join(home, 'works-index.json'), 'utf8')) as WorksIndex;

const newWork = (title: string): Promise<Record<string, unknown>> =>
  ok('work', 'new', '--title', title, '--goal', 'Цель', '--cwd', project);

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
  binDir = await mkdtemp(path.join(tmpdir(), 'parley-bin-'));
  stub = path.join(binDir, 'agent-stub');
  // `--version` заглушка отвечает свежей сборкой: перед флагом канала CLI
  // пробует версию (разговор агентов, 4.4).
  await writeFile(stub, '#!/bin/sh\necho "2.1.276 (Claude Code)"\nexit 0\n', { mode: 0o755 });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(project, { recursive: true, force: true });
  await rm(binDir, { recursive: true, force: true });
});

describe('parley-core work prune', () => {
  it('печатает снятые записи и оставляет в индексе только работы с картой', async () => {
    await newWork('Живая');
    await newWork('Снесённая');
    await rm(workPaths(project, 'w-0002').dir, { recursive: true, force: true });

    const removed = (await ok('work', 'prune')) as unknown as WorksIndex['works'];

    expect(removed).toEqual([expect.objectContaining({ id: 'w-0002', title: 'Снесённая' })]);
    expect((await readIndexFile()).works.map((work) => work.id)).toEqual(['w-0001']);
  }, 60_000);
});

describe('parley-core work new', () => {
  it('создаёт работу, карту на диске и запись в глобальном индексе', async () => {
    const created = await newWork('Авторизация');
    const map = created['map'] as WorkMap;
    expect(created['projectPath']).toBe(project);
    expect(map.work.id).toBe('w-0001');
    expect(map.work.title).toBe('Авторизация');
    expect(map.work.goal).toBe('Цель');
    expect(map.work.status).toBe('active');

    expect((await readMapFile('w-0001')).work.id).toBe('w-0001');
    const index = await readIndexFile();
    expect(index.works).toEqual([
      expect.objectContaining({ id: 'w-0001', projectPath: project, title: 'Авторизация' }),
    ]);
  }, 60_000);

  it('без --title — ошибка в stderr, stdout пуст', async () => {
    const result = await cli('work', 'new', '--cwd', project);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('--title <value> is required');
  }, 60_000);
});

describe('parley-core work list', () => {
  it('печатает работы индекса, archived — только с --all', async () => {
    await newWork('Авторизация');
    await newWork('Платежи');

    const index = await readIndexFile();
    const second = index.works.find((work) => work.title === 'Платежи') as WorkIndexEntry;
    second.status = 'archived';
    await writeFile(path.join(home, 'works-index.json'), JSON.stringify(index, null, 2), 'utf8');

    const visible = JSON.parse((await cli('work', 'list')).stdout) as WorkIndexEntry[];
    expect(visible.map((work) => work.title)).toEqual(['Авторизация']);

    const all = JSON.parse((await cli('work', 'list', '--all')).stdout) as WorkIndexEntry[];
    expect(all.map((work) => work.title)).toEqual(['Авторизация', 'Платежи']);
  }, 60_000);
});

describe('parley-core work map', () => {
  it('находит работу по глобальному индексу без --cwd', async () => {
    await newWork('Авторизация');
    const printed = await ok('work', 'map', '--work', 'w-0001');
    expect(printed['projectPath']).toBe(project);
    expect((printed['map'] as WorkMap).work.title).toBe('Авторизация');
  }, 60_000);

  it('неизвестная работа — ошибка, stdout пуст', async () => {
    const result = await cli('work', 'map', '--work', 'w-9999');
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('workspace w-9999 is not in');
  }, 60_000);
});

describe('parley-core work session new', () => {
  it('GLM refuses a secret-dependent command before writing the map even with a saved key', async () => {
    await newWork('GLM');
    await writeFile(path.join(home, 'secrets.json'), JSON.stringify({ zai: { key: 'fake-zai-key' } }));
    const before = await readMapFile('w-0001');
    const result = await cli('work', 'session', 'new', '--work', 'w-0001', '--provider', 'glm', '--label', 'test', '--task', 'test');
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/host/i);
    expect(result.stderr).not.toContain('fake-zai-key');
    expect(await readMapFile('w-0001')).toEqual(before);
  });
  it('навигатор включён по умолчанию: снимок в конфиге MCP — 1, а PARLEY_SKILL_NAVIGATOR=0 его выключает', async () => {
    await newWork('Навигатор');
    const mcpEnv = async (extra: NodeJS.ProcessEnv): Promise<Record<string, string>> => {
      const result = await cliEnv(extra, 'work', 'session', 'new', '--work', 'w-0001', '--provider', 'claude', '--label', 'a', '--task', 'x');
      expect(result.code, result.stderr).toBe(0);
      const printed = JSON.parse(result.stdout) as Record<string, unknown>;
      const config = JSON.parse(await readFile(printed['mcpConfig'] as string, 'utf8')) as { mcpServers: Record<string, { env: Record<string, string> }> };
      return config.mcpServers['parley']!.env;
    };
    // Переменные хозяина тестов не должны подменять значение по умолчанию.
    const unset = { PARLEY_SKILL_NAVIGATOR: '', HARNAS_SKILL_NAVIGATOR: '' };
    expect(await mcpEnv(unset)).toMatchObject({ PARLEY_SKILL_NAVIGATOR: '1', HARNAS_SKILL_NAVIGATOR: '1' });
    expect(await mcpEnv({ PARLEY_SKILL_NAVIGATOR: '0' })).toMatchObject({ PARLEY_SKILL_NAVIGATOR: '0', HARNAS_SKILL_NAVIGATOR: '0' });
  }, 60_000);

  it('создаёт pending, бриф, MCP-конфиг и печатает готовую команду', async () => {
    await newWork('Авторизация');
    // Базовый запуск без навигатора: один файл настроек на работу.
    const printed = await okEnv(
      { PARLEY_SKILL_NAVIGATOR: '0' },
      'work',
      'session',
      'new',
      '--work',
      'w-0001',
      '--provider',
      'claude',
      '--label',
      'план',
      '--task',
      'Составить план реализации',
    );

    expect(printed['workId']).toBe('w-0001');
    expect(printed['sessionId']).toBe('s-01');
    expect(printed['cwd']).toBe(project);
    expect(printed['command']).toBe('claude');
    // Процесс поднимает пользователь: запуск помечается как cli (дизайн TUI v2, 5.4).
    expect(printed['launchedBy']).toBe('cli');
    // Оба имени (R3): новые читает сервер, прежние — старые скрипты и сборки.
    expect(printed['env']).toEqual({
      PARLEY_WORK_DIR: workPaths(project, 'w-0001').dir,
      PARLEY_SESSION_ID: 's-01',
      HARNAS_WORK_DIR: workPaths(project, 'w-0001').dir,
      HARNAS_SESSION_ID: 's-01',
    });

    const args = printed['args'] as string[];
    const uuid = args[args.indexOf('--session-id') + 1] as string;
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(args[args.indexOf('--mcp-config') + 1]).toBe(printed['mcpConfig']);
    expect(args[args.indexOf('--settings') + 1]).toBe(printed['settings']);
    // Стартовый промпт — текст брифа: `claude` принимает его позиционным аргументом.
    const brief = await readFile(printed['brief'] as string, 'utf8');
    expect(args.at(-1)).toBe(brief);
    expect(brief).toContain('Составить план реализации');

    // Системная вставка гида идёт тем же запуском: сессия, поднятая руками,
    // знает про харнесс ровно то же, что поднятая панелью.
    const guidance = args[args.indexOf('--append-system-prompt') + 1] as string;
    expect(guidance).toContain('w-0001');
    expect(guidance).toContain('s-01');
    expect(guidance).toContain('read_guide');

    const map = await readMapFile('w-0001');
    expect(map.sessions).toHaveLength(1);
    expect(map.sessions[0]).toMatchObject({
      id: 's-01',
      provider: 'claude',
      label: 'план',
      task: 'Составить план реализации',
      parent: null,
      contextFrom: [],
      lifecycle: 'pending',
      pid: null,
      startedAtProcess: null,
      launchedBy: 'cli',
      // Id известен заранее (`--session-id`), поэтому связь с логом не теряется.
      providerSessionId: uuid,
    });

    // Файл настроек один на работу, каталог событий заведён под хук (4.2).
    expect(printed['settings']).toBe(workPaths(project, 'w-0001').settings);
    const settings = JSON.parse(await readFile(printed['settings'] as string, 'utf8')) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    expect(Object.keys(settings.hooks)).toEqual([
      'UserPromptSubmit',
      'Notification',
      'PermissionRequest',
      'Stop',
      'SubagentStart',
      'SubagentStop',
      'SessionStart',
      'SessionEnd',
    ]);
    expect(settings.hooks['Stop']?.[0]?.hooks[0]?.command).toBe(
      'cat >> "${PARLEY_WORK_DIR:-$HARNAS_WORK_DIR}/events/${PARLEY_SESSION_ID:-$HARNAS_SESSION_ID}.jsonl" || true',
    );
    expect((await stat(workPaths(project, 'w-0001').events)).isDirectory()).toBe(true);

    const config = JSON.parse(await readFile(printed['mcpConfig'] as string, 'utf8')) as {
      mcpServers: Record<string, { command: string; env: Record<string, string> }>;
    };
    expect(config.mcpServers['parley']?.env).toEqual({
      PARLEY_WORK_DIR: workPaths(project, 'w-0001').dir,
      PARLEY_SESSION_ID: 's-01',
      HARNAS_WORK_DIR: workPaths(project, 'w-0001').dir,
      HARNAS_SESSION_ID: 's-01',
      // Push включён по умолчанию: сторож входящих будит сессию звонком (4.4).
      PARLEY_CHANNEL: '1',
      HARNAS_CHANNEL: '1',
      // Один снимок настройки навигатора и ревизия нативного контекста на запуск (спека навигатора, 6.1).
      PARLEY_SKILL_NAVIGATOR: '0',
      HARNAS_SKILL_NAVIGATOR: '0',
      PARLEY_NATIVE_CONTEXT_REVISION: expect.any(String),
      HARNAS_NATIVE_CONTEXT_REVISION: expect.any(String),
    });
  }, 60_000);

  it('без --task печатает тихую команду: бриф в системной вставке, промпта нет', async () => {
    await newWork('Авторизация');
    const printed = await ok(
      'work',
      'session',
      'new',
      '--work',
      'w-0001',
      '--provider',
      'claude',
      '--label',
      'план',
    );

    const args = printed['args'] as string[];
    const guidance = args[args.indexOf('--append-system-prompt') + 1] as string;
    const brief = await readFile(printed['brief'] as string, 'utf8');
    // Бриф уходит контекстом вместе со вставкой гида, а не первым сообщением:
    // задачу пользователь напишет сам (план от 2026-09-06, раздел B).
    expect(guidance).toContain('s-01');
    expect(guidance).toContain('# Workspace w-0001');
    expect(brief).not.toContain('Task:');
    // Позиционного промпта в команде нет: бриф уехал вставкой, а хвостом стоит
    // значение флага канала.
    expect(args).not.toContain(brief);
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe(guidance);
    expect(args.at(-1)).toBe('server:parley');
    expect((await readMapFile('w-0001')).sessions[0]?.task).toBe('');
  }, 60_000);

  it('печатает команду с флагом канала, а конфиг MCP — с PARLEY_CHANNEL', async () => {
    // Сессия из терминала получает push наравне с сессией панели (4.4).
    await newWork('Авторизация');
    const printed = await ok(
      'work',
      'session',
      'new',
      '--work',
      'w-0001',
      '--provider',
      'claude',
      '--label',
      'план',
    );

    const args = printed['args'] as string[];
    expect(args[args.indexOf('--dangerously-load-development-channels') + 1]).toBe('server:parley');
    const config = JSON.parse(await readFile(printed['mcpConfig'] as string, 'utf8')) as {
      mcpServers: Record<string, { env: Record<string, string> }>;
    };
    expect(config.mcpServers['parley']?.env['PARLEY_CHANNEL']).toBe('1');
    expect(config.mcpServers['parley']?.env['HARNAS_CHANNEL']).toBe('1');
  }, 60_000);

  it('с PARLEY_CHANNEL_PUSH=0 ни флага, ни переменной: разговор живёт по pull', async () => {
    await newWork('Авторизация');
    const result = await cliEnv(
      { PARLEY_CHANNEL_PUSH: '0' },
      'work',
      'session',
      'new',
      '--work',
      'w-0001',
      '--provider',
      'claude',
      '--label',
      'план',
    );
    expect(result.code, result.stderr).toBe(0);
    const printed = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(printed['args']).not.toContain('--dangerously-load-development-channels');
    const config = JSON.parse(await readFile(printed['mcpConfig'] as string, 'utf8')) as {
      mcpServers: Record<string, { env: Record<string, string> }>;
    };
    expect(config.mcpServers['parley']?.env).not.toHaveProperty('PARLEY_CHANNEL');
    expect(config.mcpServers['parley']?.env).not.toHaveProperty('HARNAS_CHANNEL');
  }, 60_000);

  it('claude старше минимума канала: push выключен, причина — в stderr, флага в команде нет', async () => {
    await newWork('Авторизация');
    const oldClaude = path.join(binDir, 'claude-old');
    await writeFile(oldClaude, '#!/bin/sh\necho "2.1.100 (Claude Code)"\nexit 0\n', { mode: 0o755 });
    const result = await cliEnv(
      { PARLEY_CLAUDE_BIN: oldClaude },
      'work',
      'session',
      'new',
      '--work',
      'w-0001',
      '--provider',
      'claude',
      '--label',
      'план',
    );

    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toContain('push is off: claude 2.1.100 (Claude Code) is older than 2.1.211');
    const printed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(printed['args']).not.toContain('--dangerously-load-development-channels');
  }, 60_000);

  it('чужому провайдеру версия не пробуется: про push в stderr ни слова', async () => {
    // Push — возможность Claude Code, у codex и GLM канала нет вовсе (4.4).
    // Сравнивать их версию с минимумом claude бессмысленно, и лишний
    // `<провайдер> --version` на каждый запуск тоже не нужен.
    await newWork('Авторизация');
    const codexStub = path.join(binDir, 'codex-stub');
    await writeFile(codexStub, '#!/bin/sh\necho "codex-cli 0.5.0"\nexit 0\n', { mode: 0o755 });
    const result = await cliEnv(
      { PARLEY_CODEX_BIN: codexStub },
      'work',
      'session',
      'new',
      '--work',
      'w-0001',
      '--provider',
      'codex',
      '--label',
      'бэкенд',
      '--task',
      'Код',
    );

    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).not.toContain('push is off');
    expect(result.stderr).not.toContain('is older than');
    const printed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(printed['args']).not.toContain('--dangerously-load-development-channels');
  }, 60_000);

  it('--agent кладёт роль в карту и в команду запуска', async () => {
    await newWork('Авторизация');
    await mkdir(path.join(project, '.claude', 'agents'), { recursive: true });
    await writeFile(path.join(project, '.claude', 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: Review\n---\nNative role body.', 'utf8');
    const printed = await ok(
      'work',
      'session',
      'new',
      '--work',
      'w-0001',
      '--provider',
      'claude',
      '--label',
      'ревью',
      '--task',
      'Проверить план',
      '--agent',
      'reviewer',
    );

    const args = printed['args'] as string[];
    expect(args[args.indexOf('--agent') + 1]).toBe('reviewer');
    expect((await readMapFile('w-0001')).sessions[0]?.role).toEqual({ source: 'claude', name: 'reviewer' });
  }, 60_000);

  it('агента без определения и провайдера без роли CLI отвергает до записи', async () => {
    await newWork('Авторизация');
    const missing = await cli(
      'work',
      'session',
      'new',
      '--work',
      'w-0001',
      '--provider',
      'claude',
      '--label',
      'ревью',
      '--agent',
      'reviewer',
    );
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('role-missing');

    await mkdir(path.join(project, '.claude', 'agents'), { recursive: true });
    await writeFile(path.join(project, '.claude', 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: Review\n---\nNative role body.', 'utf8');
    // У codex флага роли нет: запись, которую нечем запустить ролью, не заводим.
    const foreign = await cli(
      'work',
      'session',
      'new',
      '--work',
      'w-0001',
      '--provider',
      'codex',
      '--label',
      'ревью',
      '--agent',
      'reviewer',
    );
    expect(foreign.code).toBe(1);
    expect(foreign.stderr).toContain('role-provider-mismatch');

    expect((await readMapFile('w-0001')).sessions).toHaveLength(0);
  }, 60_000);

  it('провайдеру без внешнего id uuid не выдаётся, конфиг уходит в аргументы', async () => {
    await newWork('Авторизация');
    const printed = await ok(
      'work',
      'session',
      'new',
      '--work',
      'w-0001',
      '--provider',
      'codex',
      '--label',
      'бэкенд',
      '--task',
      'Реализовать шаги 1–3',
    );

    const args = printed['args'] as string[];
    expect(args).not.toContain('--session-id');
    expect(printed['mcpConfig']).toBeNull();
    // Хуки — возможность Claude Code: чужому провайдеру файл настроек не пишется.
    expect(printed['settings']).toBeNull();
    expect(args[args.indexOf('-c') + 1]).toContain('mcp_servers.parley=');
    expect((await readMapFile('w-0001')).sessions[0]?.providerSessionId).toBeNull();
  }, 60_000);

  it('codex: напечатанная команда — та же, что запускает окно: PARLEY_* в env сервера и -c notify', async () => {
    // Codex режет серверу MCP окружение: дом харнесса (`PARLEY_HOME`) должен лежать в таблице `env` явно, а конец
    // хода приходит скриптом `notify`, которому нужен каталог `events/` работы.
    await newWork('Авторизация');
    const printed = await ok(
      'work',
      'session',
      'new',
      '--work',
      'w-0001',
      '--provider',
      'codex',
      '--label',
      'бэкенд',
      '--task',
      'Реализовать шаги 1–3',
    );

    const args = printed['args'] as string[];
    const overrides = args.flatMap((arg, index) => (args[index - 1] === '-c' ? [arg] : []));
    expect(overrides.map((override) => override.split('=')[0])).toEqual([
      'mcp_servers.parley',
      'developer_instructions',
      'project_doc_fallback_filenames',
      'tui.terminal_title',
      'tui.notifications',
      'tui.notification_method',
      'tui.notification_condition',
      'notify',
    ]);
    const mcp = overrides[0] as string;
    expect(mcp).toContain(`PARLEY_HOME=${JSON.stringify(home)}`);
    expect(mcp).toContain('PARLEY_SESSION_ID="s-01"');
    expect(mcp).toContain('HARNAS_SESSION_ID="s-01"');
    expect(overrides.at(-1)).toMatch(/^notify=\[".+node.*",".*codex-notify-bin\.js"\]$/);
    expect((await stat(workPaths(project, 'w-0001').events)).isDirectory()).toBe(true);
  }, 60_000);

  it('--context попадает в карту и в бриф', async () => {
    await newWork('Авторизация');
    await ok(
      'work',
      'session',
      'new',
      '--work',
      'w-0001',
      '--provider',
      'claude',
      '--label',
      'план',
      '--task',
      'План',
    );
    const printed = await ok(
      'work',
      'session',
      'new',
      '--work',
      'w-0001',
      '--provider',
      'claude',
      '--label',
      'бэкенд',
      '--task',
      'Код',
      '--context',
      's-01',
    );

    expect(printed['sessionId']).toBe('s-02');
    expect((await readMapFile('w-0001')).sessions[1]?.contextFrom).toEqual(['s-01']);
    expect(await readFile(printed['brief'] as string, 'utf8')).toContain('s-01');
  }, 60_000);

  it('неизвестная сессия в --context — ошибка, записи в карте нет', async () => {
    await newWork('Авторизация');
    const result = await cli(
      'work',
      'session',
      'new',
      '--work',
      'w-0001',
      '--provider',
      'claude',
      '--label',
      'бэкенд',
      '--task',
      'Код',
      '--context',
      's-07',
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('session s-07 is not in the map');
    expect((await readMapFile('w-0001')).sessions).toHaveLength(0);
  }, 60_000);

  it('неизвестный провайдер и команда не из PATH — ошибка, записи в карте нет', async () => {
    await newWork('Авторизация');
    const unknown = await cli(
      'work',
      'session',
      'new',
      '--work',
      'w-0001',
      '--provider',
      'выдумка',
      '--label',
      'роль',
      '--task',
      'Задача',
    );
    expect(unknown.code).toBe(1);
    expect(unknown.stdout).toBe('');
    expect(unknown.stderr).toContain('unknown provider выдумка; allowed: ');

    const missing = await cli(
      'work',
      'session',
      'new',
      '--work',
      'w-0001',
      '--provider',
      'glm',
      '--label',
      'роль',
      '--task',
      'Задача',
    );
    expect(missing.code).toBe(1);
    expect(missing.stdout).toBe('');
    expect(missing.stderr).toContain('requires launch through the Parley host');

    expect((await readMapFile('w-0001')).sessions).toHaveLength(0);
  }, 60_000);

  it('без --work и с неизвестной подкомандой — ошибка, stdout пуст', async () => {
    const noWork = await cli(
      'work',
      'session',
      'new',
      '--provider',
      'claude',
      '--label',
      'роль',
      '--task',
      'Задача',
    );
    expect(noWork.code).toBe(1);
    expect(noWork.stdout).toBe('');
    expect(noWork.stderr).toContain('--work <value> is required');

    const nonsense = await cli('work', 'чепуха');
    expect(nonsense.code).toBe(1);
    expect(nonsense.stdout).toBe('');
    expect(nonsense.stderr).toContain('Unknown command: work чепуха');
    expect(nonsense.stderr).toContain('a new workspace in the project');
  }, 60_000);
});


describe('source-qualified role CLI compatibility', () => {
  it('writes only the builtin role and delivers mandatory text/permissions in quiet launch argv', async () => {
    await newWork('Roles');
    const printed = await ok('work', 'session', 'new', '--work', 'w-0001', '--provider', 'claude', '--label', 'Plan', '--role', 'builtin:planner');
    const created = (await readMapFile('w-0001')).sessions[0]!;
    expect(created.role).toEqual({ source: 'builtin', name: 'planner' });
    expect(Object.hasOwn(created, 'agent')).toBe(false);
    expect(Object.hasOwn(created, 'model')).toBe(false);
    expect(Object.hasOwn(created, 'effort')).toBe(false);
    const args = printed['args'] as string[];
    expect(args[args.indexOf('--model') + 1]).toBe('opus');
    expect(args[args.indexOf('--effort') + 1]).toBe('high');
    expect(args[args.indexOf('--disallowedTools') + 1]).toBe('Edit,Write,NotebookEdit');
    expect(args[args.indexOf('--append-system-prompt') + 1]).toContain('builtin:planner');
  }, 60_000);
  it('rejects simultaneous legacy and role choices before writing a session', async () => {
    await newWork('Roles');
    const result = await cli('work', 'session', 'new', '--work', 'w-0001', '--provider', 'claude', '--label', 'Plan', '--role', 'builtin:planner', '--agent', 'legacy');
    expect(result.code).toBe(1); expect(result.stderr).toContain('agent-and-role-conflict');
    expect((await readMapFile('w-0001')).sessions).toHaveLength(0);
  }, 60_000);
});
