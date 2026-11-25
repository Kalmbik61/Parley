import { defineCatalog } from './index.js';

export const cliCatalog = defineCatalog(
  {
    usage: `parley-core — an index of Claude Code sessions as JSON

  parley-core index [--root <path>]         list of sessions, newest first
  parley-core session <id> [--root <path>]  a session with its subsessions
  parley-core schema [--provider claude|codex] [--root <path>]
                                            report on the real .jsonl schema

  parley-core work new --title <t> [--goal <g>] [--cwd <path>]
                                            a new workspace in the project
  parley-core work list [--all]             workspaces of all projects
  parley-core work prune                    delete from the database the workspaces
                                            whose project or folder is gone; a JSON
                                            copy of each goes to <home>/pruned/
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
           commands with --work the project comes from the workspace list)
  --all    also show archived workspaces`,
    requiredOption: '{name} <value> is required',
    unknownWork: 'workspace {workId} is not in the workspace list — pass --cwd',
    ambiguousWork: 'workspace {workId} exists in several projects ({projects}) — pass --cwd',
    channelMissing: 'providers.json has no {token}: push is off',
    channelUnsupported: 'push is off: claude {version} is older than {minimum}',
    agentRoleConflict: '{code}',
    providerUnavailable: 'unknown provider {provider}; allowed: {allowed}',
    managedProvider:
      '{label} requires launch through the Parley host; this CLI command cannot pass its settings folder or saved key',
    commandUnavailable: 'command {command} is not in PATH — provider {provider} is unavailable',
    contextSessionMissing: 'session {id} is not in the map',
    unknownCommand: 'Unknown command: {command}',
    unknownProvider: 'Unknown provider: {provider}',
    sessionIdRequired: 'A session id is required: parley-core session <id>',
    sessionNotFound: 'Session {id} was not found in {root}',
  },
  {
    usage: `parley-core — индекс сессий Claude Code в формате JSON

  parley-core index [--root <path>]         список сессий, новые сначала
  parley-core session <id> [--root <path>]  сессия и её дочерние сессии
  parley-core schema [--provider claude|codex] [--root <path>]
                                            отчёт о фактической схеме .jsonl

  parley-core work new --title <t> [--goal <g>] [--cwd <path>]
                                            создать работу в проекте
  parley-core work list [--all]             работы всех проектов
  parley-core work prune                    удалить из базы работы, чьи проекты
                                            или каталоги исчезли, и сохранить
                                            их копии JSON в <home>/pruned/
  parley-core work map --work <id> [--cwd <path>]
                                            показать карту работы
  parley-core work session new --work <id> --provider <p> --label <l>
      [--task <t>] [--context s-01,s-02] [--role <source:name> | --agent <name>] [--cwd <path>]
                                            подготовить запись сессии, бриф,
                                            конфигурацию MCP, settings.json
                                            с хуками и команду запуска.
                                            Без --task бриф передаётся
                                            как контекст, а задачу вводит
                                            пользователь. --role принимает ID
                                            роли с источником. --agent принимает
                                            точное metadata.name роли Claude.

  --json   единственный формат данных, флаг сохранён для совместимости
  --root   корень истории (по умолчанию ~/.claude/projects, только чтение)
  --cwd    проект с \`.parley/\` (по умолчанию текущий каталог. Для команд
           с --work проект определяется по списку работ)
  --all    дополнительно показать архивные работы`,
    requiredOption: 'Укажите {name} <value>',
    unknownWork: 'Работы {workId} нет в списке. Укажите --cwd',
    ambiguousWork: 'Работа {workId} есть в нескольких проектах ({projects}). Укажите --cwd',
    channelMissing: 'В providers.json нет {token}. Доставка push отключена',
    channelUnsupported:
      'Доставка push отключена. Для неё нужна версия claude {minimum} или новее. Установлена версия {version}',
    agentRoleConflict: 'Используйте либо --agent, либо --role ({code})',
    providerUnavailable: 'Неизвестный провайдер {provider}. Допустимые значения: {allowed}',
    managedProvider:
      'Запустите {label} через хост Parley. Команда CLI не передаёт папку настроек или сохранённый ключ',
    commandUnavailable: 'Команды {command} нет в PATH. Провайдер {provider} недоступен',
    contextSessionMissing: 'Сессии {id} нет на карте',
    unknownCommand: 'Неизвестная команда: {command}',
    unknownProvider: 'Неизвестный провайдер: {provider}',
    sessionIdRequired: 'Укажите идентификатор сессии: parley-core session <id>',
    sessionNotFound: 'Сессия {id} не найдена в {root}',
  },
);
