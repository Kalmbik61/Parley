import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Описание запуска workflow из `<session-id>/workflows/wf_<runId>.json`.
 *
 * Меток по отдельным агентам там нет (logs — просто строки, phases общие для
 * всего запуска), поэтому дескриптор годится только как группировка.
 */
export interface WorkflowInfo {
  runId: string;
  name: string | null;
  status: string | null;
  agentCount: number | null;
  durationMs: number | null;
}

function str(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function num(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Читает один дескриптор. Файла может не быть — это не ошибка. */
export async function readWorkflowDescriptor(file: string): Promise<WorkflowInfo | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const raw = parsed as Record<string, unknown>;
  return {
    runId: str(raw, 'runId') ?? path.basename(file, '.json'),
    name: str(raw, 'workflowName'),
    status: str(raw, 'status'),
    agentCount: num(raw, 'agentCount'),
    durationMs: num(raw, 'durationMs'),
  };
}

/**
 * Собирает дескрипторы всех workflow сессии.
 *
 * Каталог лежит рядом с subagents: `<project>/<session-id>/workflows/`.
 */
export async function readSessionWorkflows(
  sessionFile: string,
): Promise<Map<string, WorkflowInfo>> {
  const dir = path.join(
    path.dirname(sessionFile),
    path.basename(sessionFile, '.jsonl'),
    'workflows',
  );

  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return new Map(); // workflow в сессии не запускались
  }

  const found = new Map<string, WorkflowInfo>();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith('wf_') || !entry.name.endsWith('.json')) continue;
    const info = await readWorkflowDescriptor(path.join(dir, entry.name));
    if (info !== null) found.set(path.basename(entry.name, '.json'), info);
  }
  return found;
}
