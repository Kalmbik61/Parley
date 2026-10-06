#!/usr/bin/env node
// Контракт ядра с любым фронтендом: команды печатают в stdout ТОЛЬКО JSON.
// Диагностика идёт в stderr, код возврата ненулевой при ошибке.

import { randomUUID } from 'node:crypto';

import path from 'node:path';
import { defaultCodexRoot, discoverCodexSessions } from './codex/discover.js';
import { defaultRoot, discoverSessions } from './discover.js';
import { commandInPath, loadProviders } from './providers.js';
import type { ProviderEntry } from './providers.js';
import { buildSchemaReport } from './schema-report.js';
import { buildIndex, buildSessionTree } from './session-tree.js';
import { loadConfig } from './config.js';
import { bothEnv } from './names.js';
import { prepareSessionRole, roleFromId, roleId } from './work/agents.js';
import { planLaunch } from './work/launch.js';
import { writeBrief } from './work/brief.js';
import {
  CHANNEL_MIN_VERSION,
  NO_CHANNEL_WARNING,
  probeChannelSupport,
} from './work/channel.js';
import { addSession } from './work/map.js';
import {
  createWork,
  pruneWorksIndex,
  readMap,
  readWorksIndex,
  updateMap,
  workPaths,
  worksIndexPath,
} from './work/store.js';

const USAGE = `parley-core — an index of Claude Code sessions as JSON

  parley-core index [--root <path>]         list of sessions, newest first
  parley-core session <id> [--root <path>]  a session with its subsessions
  parley-core schema [--provider claude|codex] [--root <path>]
                                            report on the real .jsonl schema

  parley-core work new --title <t> [--goal <g>] [--cwd <path>]
                                            a new workspace in the project
  parley-core work list [--all]             workspaces of the global index
  parley-core work prune                    remove from the index the workspaces
                                            that have no map
  parley-core work map --work <id> [--cwd <path>]
                                            the workspace map
  parley-core work session new --work <id> --provider <p> --label <l>
      [--task <t>] [--context s-01,s-02] [--role <source:name> | --agent <name>] [--cwd <path>]
                                            a pending record, the brief, the MCP
                                            config, settings.json with hooks and
                                            a ready launch command; without
                                            --task the start is quiet: the brief
                                            goes in as context, and the user
                                            types the task themselves;
                                            --role is a source-qualified role;
                                            --agent is a legacy Claude role alias
                                            matching exact metadata.name

  --json   the default and only format, accepted for compatibility
  --root   history root (default ~/.claude/projects, read-only)
  --cwd    a project with \`.parley/\` (default: the current directory; for
           commands with --work the project comes from the global index)
  --all    also show archived workspaces`;

function optionValue(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

function requiredOption(argv: string[], name: string): string {
  const value = optionValue(argv, name);
  if (value === undefined || value === '') throw new Error(`${name} <value> is required`);
  return value;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Проект работы: явный `--cwd` или запись глобального индекса. Индекс и есть
 * список «где какая работа лежит», поэтому по `--work` каталог знать не нужно;
 * одинаковый id в двух проектах (копия проекта с закоммиченным каталогом состояния) —
 * повод спросить `--cwd`, а не гадать.
 */
async function resolveProject(argv: string[], workId: string): Promise<string> {
  const cwd = optionValue(argv, '--cwd');
  if (cwd !== undefined) return path.resolve(cwd);

  const found = (await readWorksIndex()).works.filter((work) => work.id === workId);
  if (found.length === 0) {
    throw new Error(`workspace ${workId} is not in ${worksIndexPath()} — pass --cwd`);
  }
  if (found.length > 1) {
    const projects = found.map((work) => work.projectPath).join(', ');
    throw new Error(`workspace ${workId} exists in several projects (${projects}) — pass --cwd`);
  }
  return (found[0] as { projectPath: string }).projectPath;
}

/**
 * Уходит ли в команду флаг канала (разговор агентов, 4.4). Настройка
 * `channelPush`, проба `claude --version` и шаблон аргументов: у оверрайда
 * `providers.json` без `{channel}` push выключается законно, но молча —
 * поэтому о нём, как и о старой сборке, говорит stderr. Стандарт стдаут-JSON
 * при этом не нарушается: диагностика туда не попадает.
 */
async function channelFor(entry: ProviderEntry): Promise<boolean> {
  const { config } = await loadConfig();
  if (!config.channelPush) return false;

  // Сначала чужие: у codex и GLM канала нет вовсе — ни флага, ни переменной
  // (4.4). Пробовать их версию нечем и не с чем: минимум `2.1.211` — про
  // claude, а лишний `<провайдер> --version` стоил бы подпроцесса на запуск.
  if (entry.id !== 'claude') return false;
  if (entry.runner.args?.includes('{channel}') !== true) {
    process.stderr.write(`${NO_CHANNEL_WARNING}\n`);
    return false;
  }

  const probe = await probeChannelSupport(entry.runner.command);
  if (!probe.supported) {
    process.stderr.write(
      `push is off: claude ${probe.version} is older than ${CHANNEL_MIN_VERSION}\n`,
    );
    return false;
  }
  return true;
}

/**
 * Готовит запуск сессии без окна (спецификация, раздел 4): запись `pending`,
 * бриф и MCP-конфиг на диске, команда запуска — в stdout. Сам процесс агента
 * харнесс тут не поднимает: пользователь запускает его руками из своего
 * терминала, поэтому в панель такая сессия не подключается.
 */
async function newWorkSession(argv: string[]): Promise<void> {
  const workId = requiredOption(argv, '--work');
  const provider = requiredOption(argv, '--provider');
  const label = requiredOption(argv, '--label');
  // Задача необязательна: без неё сессия стартует тихо — бриф уходит контекстом
  // в системный промпт, а запрос пишет пользователь (план от 2026-09-06, B).
  const task = optionValue(argv, '--task') ?? '';
  const contextFrom = (optionValue(argv, '--context') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
  // Роль Claude Code необязательна: без неё сессия идёт обычным агентом.
  const agent = optionValue(argv, '--agent');
  const roleArg = optionValue(argv, '--role');
  if (agent !== undefined && roleArg !== undefined) throw new Error('agent-and-role-conflict');
  const role = roleArg === undefined ? (agent === undefined ? null : { source: 'claude' as const, name: agent }) : roleFromId(roleArg);
  const projectPath = await resolveProject(argv, workId);

  // Провайдера и бинарь проверяем до записи: запись `pending`, которую нечем
  // запустить, — мусор в карте (спецификация, раздел 8).
  const registry = await loadProviders();
  const entry = registry[provider];
  if (entry === undefined) {
    throw new Error(`unknown provider ${provider}; allowed: ${Object.keys(registry).join(', ')}`);
  }
  // Printed CLI commands have no host boundary for process-only secret delivery.
  if (entry.runner.secret !== undefined) {
    throw new Error('GLM requires launch through the Parley host; this CLI command cannot inject its saved key');
  }
  if (!(await commandInPath(entry.runner.command))) {
    throw new Error(
      `command ${entry.runner.command} is not in PATH — provider ${provider} is unavailable`,
    );
  }

  // Роль проверяется там же, где провайдер и бинарь: запись `pending`, которую
  // нечем запустить ролью, — тот же мусор в карте (спецификация 2026-09-08, 7).
  await prepareSessionRole(projectPath, entry, { roleId: roleId(role), provider, mode: 'create' });

  // Провайдеру, принимающему id снаружи, uuid выдаём сразу и кладём в карту:
  // иначе после ручного запуска связь записи с логом провайдера потерялась бы.
  const uuid = entry.linkBy === 'session-id' ? randomUUID() : null;
  let created = '';
  const map = await updateMap(projectPath, workId, (current) => {
    for (const id of contextFrom) {
      if (!current.sessions.some((session) => session.id === id)) {
        throw new Error(`session ${id} is not in the map`);
      }
    }
    const session = addSession(current, {
      provider,
      label,
      task,
      parent: null,
      contextFrom,
      role,
    });
    if (uuid !== null) session.providerSessionId = uuid;
    // Процесс поднимет пользователь напечатанной командой: pid харнессу неизвестен,
    // живость такой сессии видна только по логу (дизайн TUI v2, раздел 5.4).
    session.launchedBy = 'cli';
    created = session.id;
  });

  const paths = workPaths(projectPath, workId);
  const brief = await writeBrief(projectPath, map, created);
  // Бриф читаем с диска: между записью и запуском его можно править (раздел 11).
  const channel = await channelFor(entry);
  const session = map.sessions.find(item => item.id === created)!;
  const plan = await planLaunch(projectPath, workId, session, { channel });
  const { command, args } = plan;
  const mcpFile = entry.runner.mcpConfig === 'json-file' ? path.join(paths.mcp, `${created}.json`) : null;
  const settingsFile = (entry.runner.args ?? []).includes('{settingsFile}') ? args[args.indexOf('--settings') + 1] ?? null : null;
  print({
    workId,
    sessionId: created,
    brief,
    mcpConfig: mcpFile,
    settings: settingsFile,
    launchedBy: 'cli',
    command,
    args,
    cwd: projectPath,
    // Окружение запускаемого процесса: те же переменные, что MCP-сервер получает
    // из конфига, — с ними он знает, кто звонит, даже унаследовав их от агента. Под обоими
    // именами: прежние читают старые скрипты и сервер прежней сборки (R3).
    env: bothEnv({ WORK_DIR: paths.dir, SESSION_ID: created }),
  });
}

/** Команды слоя координации: работа, её карта и сессии (спецификация, раздел 4). */
async function workCommand(rest: string[], argv: string[]): Promise<number> {
  const [subcommand, ...tail] = rest;

  if (subcommand === 'new') {
    const projectPath = path.resolve(optionValue(argv, '--cwd') ?? process.cwd());
    const title = requiredOption(argv, '--title');
    const goal = optionValue(argv, '--goal');
    const map = await createWork(projectPath, goal === undefined ? { title } : { title, goal });
    print({ projectPath, map });
    return 0;
  }

  if (subcommand === 'list') {
    // `archived` в списке не показываются (спецификация, раздел 11).
    const all = argv.includes('--all');
    const { works } = await readWorksIndex();
    print(all ? works : works.filter((work) => work.status !== 'archived'));
    return 0;
  }

  if (subcommand === 'prune') {
    // Записи без карты на диске: работу снесли мимо харнесса или проект уехал.
    print(await pruneWorksIndex());
    return 0;
  }

  if (subcommand === 'map') {
    const workId = requiredOption(argv, '--work');
    const projectPath = await resolveProject(argv, workId);
    print({ projectPath, map: await readMap(projectPath, workId) });
    return 0;
  }

  if (subcommand === 'session' && tail[0] === 'new') {
    await newWorkSession(argv);
    return 0;
  }

  process.stderr.write(`Unknown command: work ${rest.join(' ')}\n${USAGE}\n`);
  return 1;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const root = optionValue(argv, '--root') ?? defaultRoot();

  if (command === undefined || command === '--help' || command === '-h') {
    process.stderr.write(`${USAGE}\n`);
    return command === undefined ? 1 : 0;
  }

  if (command === 'work') {
    try {
      return await workCommand(rest, argv);
    } catch (error) {
      process.stderr.write(`${(error as Error).message}\n`);
      return 1;
    }
  }

  if (command === 'index') {
    print(await buildIndex(root));
    return 0;
  }

  if (command === 'schema') {
    const provider = optionValue(argv, '--provider') ?? 'claude';
    if (provider !== 'claude' && provider !== 'codex') {
      process.stderr.write(`Unknown provider: ${provider}\n`);
      return 1;
    }

    // Файлы берём у того же обходчика, что и индекс: отчёт должен смотреть
    // ровно на то, что читает парсер.
    const files =
      provider === 'codex'
        ? (await discoverCodexSessions(optionValue(argv, '--root') ?? defaultCodexRoot())).map(
            (session) => session.file,
          )
        : (await discoverSessions(root)).flatMap((session) => [
            session.file,
            ...session.subagents.map((agent) => agent.file),
          ]);

    print(await buildSchemaReport(files));
    return 0;
  }

  if (command === 'session') {
    const id = rest.find((arg) => !arg.startsWith('--'));
    if (id === undefined) {
      process.stderr.write('A session id is required: parley-core session <id>\n');
      return 1;
    }

    const sessions = await discoverSessions(root);
    // Сессию ищем и по sessionId из записей, и по имени файла — в UI встречаются оба.
    const found =
      sessions.find((session) => session.id === id) ??
      (await (async () => {
        for (const session of sessions) {
          const tree = await buildSessionTree(session, root);
          if (tree.session.id === id) return session;
        }
        return undefined;
      })());

    if (found === undefined) {
      process.stderr.write(`Session ${id} was not found in ${root}\n`);
      return 1;
    }

    print(await buildSessionTree(found, root));
    return 0;
  }

  process.stderr.write(`Unknown command: ${command}\n${USAGE}\n`);
  return 1;
}

process.exitCode = await main(process.argv.slice(2));
