import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/** Корень истории Claude Code. Каталог только для чтения. */
export function defaultRoot(): string {
  return path.join(homedir(), '.claude', 'projects');
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

async function readDirSafe(dir: string): Promise<import('node:fs').Dirent[]> {
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
    if (!project.isDirectory()) continue;
    const projectDir = path.join(root, project.name);

    for (const entry of await readDirSafe(projectDir)) {
      if (!entry.isFile() || !entry.name.endsWith(JSONL)) continue;

      const id = entry.name.slice(0, -JSONL.length);
      sessions.push({
        file: path.join(projectDir, entry.name),
        id,
        project: project.name,
        subagents: await collectSubagents(path.join(projectDir, id, 'subagents'), null),
      });
    }
  }

  return sessions;
}
