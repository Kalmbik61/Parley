#!/usr/bin/env node
// Контракт ядра с любым фронтендом: команды печатают в stdout ТОЛЬКО JSON.
// Диагностика идёт в stderr, код возврата ненулевой при ошибке.

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { defaultCodexRoot, discoverCodexSessions } from './codex/discover.js';
import { defaultRoot, discoverSessions } from './discover.js';
import { commandInPath, loadProviders, startCommand } from './providers.js';
import type { ProviderEntry, RunnerSubstitutions } from './providers.js';
import { buildSchemaReport } from './schema-report.js';
import { buildIndex, buildSessionTree } from './session-tree.js';
import { loadConfig } from './config.js';
import { writeBrief } from './work/brief.js';
import { CHANNEL_MIN_VERSION, probeChannelSupport } from './work/channel.js';
import { systemGuidance } from './work/guidance.js';
import { addSession } from './work/map.js';
import { MCP_SERVER_NAME, mcpConfigValue, writeMcpConfig } from './work/mcp-config.js';
import { writeWorkSettings } from './work/settings-file.js';
import {
  createWork,
  pruneWorksIndex,
  readMap,
  readWorksIndex,
  updateMap,
  workPaths,
  worksIndexPath,
} from './work/store.js';

const USAGE = `harnas-core — индекс сессий Claude Code в JSON

  harnas-core index [--root <путь>]         список сессий, свежие первыми
  harnas-core session <id> [--root <путь>]  сессия с подсессиями
  harnas-core schema [--provider claude|codex] [--root <путь>]
                                            отчёт по реальной схеме .jsonl

  harnas-core work new --title <t> [--goal <g>] [--cwd <путь>]
                                            новая работа в проекте
  harnas-core work list [--all]             работы глобального индекса
  harnas-core work prune                    снять из индекса работы без карты
  harnas-core work map --work <id> [--cwd <путь>]
                                            карта работы
  harnas-core work session new --work <id> --provider <p> --label <l>
      [--task <t>] [--context s-01,s-02] [--cwd <путь>]
                                            запись pending, бриф, MCP-конфиг,
                                            settings.json с хуками и готовая
                                            команда запуска; без --task старт
                                            тихий: бриф уходит контекстом, а
                                            задачу пишет пользователь сам

  --json   формат по умолчанию и единственный, принимается для совместимости
  --root   корень истории (по умолчанию ~/.claude/projects, только чтение)
  --cwd    проект с \`.harnas/\` (по умолчанию текущий каталог; для команд по
           --work проект берётся из глобального индекса)
  --all    показывать и archived работы`;

function optionValue(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

function requiredOption(argv: string[], name: string): string {
  const value = optionValue(argv, name);
  if (value === undefined || value === '') throw new Error(`нужен ${name} <значение>`);
  return value;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Проект работы: явный `--cwd` или запись глобального индекса. Индекс и есть
 * список «где какая работа лежит», поэтому по `--work` каталог знать не нужно;
 * одинаковый id в двух проектах (копия проекта с закоммиченным `.harnas/`) —
 * повод спросить `--cwd`, а не гадать.
 */
async function resolveProject(argv: string[], workId: string): Promise<string> {
  const cwd = optionValue(argv, '--cwd');
  if (cwd !== undefined) return path.resolve(cwd);

  const found = (await readWorksIndex()).works.filter((work) => work.id === workId);
  if (found.length === 0) {
    throw new Error(`работы ${workId} нет в ${worksIndexPath()} — укажите --cwd`);
  }
  if (found.length > 1) {
    const projects = found.map((work) => work.projectPath).join(', ');
    throw new Error(`работа ${workId} есть в нескольких проектах (${projects}) — укажите --cwd`);
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

  const probe = await probeChannelSupport(entry.runner.command);
  if (!probe.supported) {
    process.stderr.write(`push выключен: claude ${probe.version} младше ${CHANNEL_MIN_VERSION}\n`);
    return false;
  }
  if (entry.runner.args?.includes('{channel}') !== true) {
    // Чужому провайдеру звонок не положен вовсе; про Claude молчать нельзя.
    if (entry.id === 'claude') {
      process.stderr.write('providers.json без {channel}: push выключен\n');
    }
    return false;
  }
  return true;
}

/**
 * Готовит запуск сессии без TUI (спецификация, раздел 4): запись `pending`,
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
  const projectPath = await resolveProject(argv, workId);

  // Провайдера и бинарь проверяем до записи: запись `pending`, которую нечем
  // запустить, — мусор в карте (спецификация, раздел 8).
  const registry = await loadProviders();
  const entry = registry[provider];
  if (entry === undefined) {
    throw new Error(
      `неизвестный провайдер ${provider}; допустимы: ${Object.keys(registry).join(', ')}`,
    );
  }
  if (!(await commandInPath(entry.runner.command))) {
    throw new Error(
      `команды ${entry.runner.command} нет в PATH — провайдер ${provider} недоступен`,
    );
  }

  // Провайдеру, принимающему id снаружи, uuid выдаём сразу и кладём в карту:
  // иначе после ручного запуска связь записи с логом провайдера потерялась бы.
  const uuid = entry.linkBy === 'session-id' ? randomUUID() : null;
  let created = '';
  const map = await updateMap(projectPath, workId, (current) => {
    for (const id of contextFrom) {
      if (!current.sessions.some((session) => session.id === id)) {
        throw new Error(`сессии ${id} нет в карте`);
      }
    }
    const session = addSession(current, { provider, label, task, parent: null, contextFrom });
    if (uuid !== null) session.providerSessionId = uuid;
    // Процесс поднимет пользователь напечатанной командой: pid харнессу неизвестен,
    // живость такой сессии видна только по логу (дизайн TUI v2, раздел 5.4).
    session.launchedBy = 'cli';
    created = session.id;
  });

  const paths = workPaths(projectPath, workId);
  const brief = await writeBrief(projectPath, map, created);
  // Бриф читаем с диска: между записью и запуском его можно править (раздел 11).
  const briefText = await readFile(brief, 'utf8');
  // Push через channel: настройка, проба версии и шаблон аргументов. Сессия из
  // терминала получает звонок наравне с сессией панели (разговор агентов, 4.4).
  const channel = await channelFor(entry);
  // Файл конфига нужен только тем, кто принимает путь; codex получает свой
  // сервер значением `-c`, и лишний файл ему писать незачем.
  const mcpFile =
    entry.runner.mcpConfig === 'json-file'
      ? await writeMcpConfig(projectPath, workId, created, undefined, channel)
      : null;
  const mcp = mcpConfigValue(
    entry.runner.mcpConfig,
    { workDir: paths.dir, sessionId: created },
    mcpFile ?? '',
  );
  // Файл настроек с хуками нужен только тем, кто его принимает (`claude --settings`).
  const settingsFile = (entry.runner.args ?? []).includes('{settingsFile}')
    ? await writeWorkSettings(projectPath, workId)
    : null;

  // Тихий старт: бриф едет не первым сообщением, а контекстом вместе со
  // вставкой гида — агент ждёт запроса пользователя.
  const subs: RunnerSubstitutions = task === '' ? {} : { prompt: briefText };
  if (uuid !== null) subs.sessionUuid = uuid;
  if (mcp !== undefined) subs.mcpConfig = mcp;
  if (channel) subs.channel = `server:${MCP_SERVER_NAME}`;
  if (settingsFile !== null) subs.settingsFile = settingsFile;
  // Системная вставка гида — тому, кто её принимает (`claude --append-system-prompt`):
  // сессия, поднятая руками, должна знать про харнесс то же, что поднятая панелью.
  if ((entry.runner.args ?? []).includes('{systemPrompt}')) {
    const guidance = systemGuidance(map, created);
    subs.systemPrompt = task === '' ? `${guidance}\n\n${briefText}` : guidance;
  }
  const { command, args } = startCommand(entry, subs);

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
    // из конфига, — с ними он знает, кто звонит, даже унаследовав их от агента.
    env: { HARNAS_WORK_DIR: paths.dir, HARNAS_SESSION_ID: created },
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

  process.stderr.write(`Неизвестная команда: work ${rest.join(' ')}\n${USAGE}\n`);
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
      process.stderr.write(`Неизвестный провайдер: ${provider}\n`);
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
      process.stderr.write('Нужен id сессии: harnas-core session <id>\n');
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
      process.stderr.write(`Сессия ${id} не найдена в ${root}\n`);
      return 1;
    }

    print(await buildSessionTree(found, root));
    return 0;
  }

  process.stderr.write(`Неизвестная команда: ${command}\n${USAGE}\n`);
  return 1;
}

process.exitCode = await main(process.argv.slice(2));
