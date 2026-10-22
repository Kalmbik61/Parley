import { readdirSync, type Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { CODEX_ACCOUNT_PREFIX, customProviderDir, isCustomProviderId, isValidCustomProviderId } from './custom-providers.js';
import { envValue } from './names.js';
import { parleyHome } from './work/store.js';

/** Рабочая папка CLI помощника (спека 2026-10-14, 15.6): её транскрипты — не сессии Parley. */
export function assistantCwd(home: string = parleyHome()): string {
  return path.join(home, 'assistant');
}

/** Имя каталога проекта в `~/.claude/projects`: Claude Code заменяет всё, кроме латинских букв и цифр, дефисом. */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

const assistantSlug = (): string => claudeProjectSlug(assistantCwd());

/**
 * Переопределение корня истории Claude Code — только для тестов (раунд lane-r3, п. 1):
 * E2E окна поднимают настоящий хост, и без неё каждый читал бы всю историю человека.
 * Подмена `HOME` не годится — логин-шелл окна тогда находит другой `node`.
 * Ключ без префикса: переменная — `PARLEY_CLAUDE_PROJECTS_DIR`, прежняя `HARNAS_CLAUDE_PROJECTS_DIR` читается тоже.
 */
export const CLAUDE_PROJECTS_DIR_KEY = 'CLAUDE_PROJECTS_DIR';

/**
 * Все корни, где Claude Code держит историю, для вопроса «есть ли такой транскрипт» (0.2.0): подмена
 * `PARLEY_CLAUDE_PROJECTS_DIR` (тесты, E2E) — только она; иначе `$CLAUDE_CONFIG_DIR/projects`, если
 * переменная задана (Claude Code пишет туда, куда она указывает), и `~/.claude/projects`. Только пути —
 * ничего не читается. Окружение — хоста: оно же у агентов, которых он запускает.
 */
export function claudeProjectRoots(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string[] {
  const override = envValue(env, CLAUDE_PROJECTS_DIR_KEY);
  if (override !== undefined) return [override];
  const roots: string[] = [];
  const configDir = env['CLAUDE_CONFIG_DIR']?.trim();
  if (configDir !== undefined && configDir !== '') roots.push(path.join(configDir, 'projects'));
  roots.push(path.join(home, '.claude', 'projects'));
  // Свои провайдеры пишут историю в свою папку (спека своих провайдеров 5.6).
  roots.push(...customProviderProjectRoots(parleyHome(env, home)));
  return [...new Set(roots)];
}

/**
 * Корни истории своих провайдеров: `projects` в подпапках `<home>/providers` с префиксом `custom-` (спека своих провайдеров 5.6).
 * Папки `codex-*` (аккаунты Codex) — не корни Claude и сюда не попадают (спека подписок 5.1, К8).
 * Синхронно, только пути; нет каталога `providers` — `[]`.
 */
export function customProviderProjectRoots(home: string = parleyHome()): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(path.join(home, 'providers'), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && isCustomProviderId(entry.name) && isValidCustomProviderId(entry.name))
    .map((entry) => path.join(customProviderDir(entry.name, home), 'projects'))
    .sort();
}

/** Корень истории Claude Code. Каталог только для чтения. */
export function defaultRoot(): string {
  const override = envValue(process.env, CLAUDE_PROJECTS_DIR_KEY);
  if (override !== undefined) return override;
  return path.join(homedir(), '.claude', 'projects');
}

/** Корень истории провайдера: свой (`custom-*`) — из его папки, остальные — как у Claude Code (спека 5.6). */
export function claudeRootFor(provider: string): string {
  // У аккаунта Codex нет корня Claude; зовут эту функцию только для семейства Claude (спека подписок 5.1).
  if (provider.startsWith(CODEX_ACCOUNT_PREFIX)) throw new Error(`Provider ${provider} has no Claude history root`);
  if (isValidCustomProviderId(provider)) return path.join(customProviderDir(provider), 'projects');
  return defaultRoot();
}

export interface DiscoveredSubagent {
  file: string;
  /** Соседний agent-<id>.meta.json — может не существовать. */
  metaFile: string;
  agentId: string;
  /** wf_<runId>, если агент запускался внутри workflow. */
  workflowRunId: string | null;
}

export interface DiscoveredSession {
  file: string;
  /** Идентификатор из имени файла; sessionId из записей сверяется при индексации. */
  id: string;
  project: string;
  subagents: DiscoveredSubagent[];
}

const AGENT_PREFIX = 'agent-';
const JSONL = '.jsonl';

async function readDirSafe(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    // Каталог мог исчезнуть между обходом и чтением — это не ошибка обхода.
    return [];
  }
}

/**
 * Рекурсивно собирает файлы субагентов под <session-id>/subagents/.
 * journal.jsonl — лог workflow, не подсессия (см. specs/data-layer.md).
 */
async function collectSubagents(dir: string, workflowRunId: string | null) {
  const found: DiscoveredSubagent[] = [];

  for (const entry of await readDirSafe(dir)) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      const runId = entry.name.startsWith('wf_') ? entry.name : workflowRunId;
      found.push(...(await collectSubagents(full, runId)));
      continue;
    }

    if (!entry.isFile()) continue;
    if (!entry.name.startsWith(AGENT_PREFIX) || !entry.name.endsWith(JSONL)) continue;

    const agentId = entry.name.slice(AGENT_PREFIX.length, -JSONL.length);
    found.push({
      file: full,
      metaFile: path.join(dir, `${AGENT_PREFIX}${agentId}.meta.json`),
      agentId,
      workflowRunId,
    });
  }

  return found;
}

/**
 * Обходит ~/.claude/projects и возвращает НАСТОЯЩИЕ сессии с их подсессиями.
 *
 * Дискриминатор — путь, а не содержимое: сессия это <project>/<id>.jsonl, всё под
 * <project>/<id>/subagents/ принадлежит ей. Файлы субагентов несут sessionId
 * родителя, поэтому по содержимому их не различить.
 */
export async function discoverSessions(root: string = defaultRoot()): Promise<DiscoveredSession[]> {
  const sessions: DiscoveredSession[] = [];

  for (const project of await readDirSafe(root)) {
    if (!project.isDirectory() || project.name === assistantSlug()) continue;
    const projectDir = path.join(root, project.name);

    for (const entry of await readDirSafe(projectDir)) {
      if (!entry.isFile() || !entry.name.endsWith(JSONL)) continue;
      sessions.push(await discoverSession(path.join(projectDir, entry.name), root));
    }
  }

  return sessions;
}

/** То же самое для одного файла сессии — нужно watcher'у при инкрементальном ре-парсе. */
export async function discoverSession(
  file: string,
  root: string = defaultRoot(),
): Promise<DiscoveredSession> {
  const projectDir = path.dirname(file);
  const id = path.basename(file, JSONL);
  return {
    file,
    id,
    project: path.relative(root, projectDir) || path.basename(projectDir),
    subagents: await collectSubagents(path.join(projectDir, id, 'subagents'), null),
  };
}

/**
 * Какой сессии принадлежит изменившийся путь. Файл субагента относится к своей
 * родительской сессии: подсессии живут в отдельных файлах, и их изменение обязано
 * обновлять родителя.
 *
 * Возвращает null, если путь к сессиям отношения не имеет (MEMORY.md, wf_*.json,
 * sessions-index.json и прочее).
 */
export function sessionFileForPath(changedPath: string, root: string): string | null {
  const relative = path.relative(root, changedPath);
  if (relative === '' || relative.startsWith('..')) return null;

  const segments = relative.split(path.sep);
  const [project, second] = segments;
  if (project === undefined || second === undefined) return null;
  // Транскрипты помощника — не сессии Parley, watcher их не перечитывает.
  if (project === assistantSlug()) return null;

  // <project>/<id>.jsonl — сама сессия.
  if (segments.length === 2) {
    return second.endsWith(JSONL) ? path.join(root, project, second) : null;
  }

  // <project>/<id>/subagents/... — подсессия, отвечает родительский файл.
  if (segments[2] !== 'subagents') return null;
  return path.join(root, project, `${second}${JSONL}`);
}
