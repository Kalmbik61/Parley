import { readFile } from 'node:fs/promises';
import { forEachJsonlRecord } from './jsonl.js';
import { adapterV1, type SchemaAdapter } from './adapter-v1.js';
import type { DiscoveredSubagent } from './discover.js';

/** Содержимое agent-<id>.meta.json. У workflow-агентов заполнены только два поля. */
export interface SubagentMeta {
  agentType: string | null;
  name: string | null;
  description: string | null;
  /** tool_use в родительской сессии, откуда агент запущен. Есть не у всех. */
  toolUseId: string | null;
  spawnDepth: number | null;
}

export interface Subsession {
  agentId: string;
  file: string;
  workflowRunId: string | null;
  agentType: string | null;
  name: string | null;
  /** Что делал агент: description из meta, иначе первая реплика. */
  task: string | null;
  /** Откуда взята задача — meta точнее, реплика приблизительна. */
  taskSource: 'meta' | 'first-text' | null;
  toolUseId: string | null;
  /** Уникальные модели агента — из них собираются бейджи. */
  models: string[];
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  records: number;
}

function str(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Читает meta.json субагента. Файла может не быть — это не ошибка. */
export async function readSubagentMeta(metaFile: string): Promise<SubagentMeta | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(metaFile, 'utf8'));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const meta = parsed as Record<string, unknown>;
  const depth = meta['spawnDepth'];
  return {
    agentType: str(meta, 'agentType'),
    name: str(meta, 'name'),
    description: str(meta, 'description'),
    toolUseId: str(meta, 'toolUseId'),
    spawnDepth: typeof depth === 'number' ? depth : null,
  };
}

function oneLine(text: string, limit = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/**
 * Индексирует файл подсессии. Задача берётся из meta.description; у workflow-агентов
 * meta содержит только {agentType, spawnDepth}, поэтому там задача — первая реплика.
 */
export async function indexSubsession(
  subagent: DiscoveredSubagent,
  adapter: SchemaAdapter = adapterV1,
): Promise<Subsession> {
  const meta = await readSubagentMeta(subagent.metaFile);

  const models = new Set<string>();
  let firstText: string | null = null;
  let startedAt: string | null = null;
  let endedAt: string | null = null;

  const stats = await forEachJsonlRecord(subagent.file, (raw) => {
    const record = adapter.toSessionRecord(raw);
    if (record.model !== null) models.add(record.model);
    if (firstText === null && record.text !== null) firstText = record.text;

    const at = record.timestamp;
    if (at !== null) {
      if (startedAt === null || at < startedAt) startedAt = at;
      if (endedAt === null || at > endedAt) endedAt = at;
    }
  });

  const task = meta?.description ?? (firstText === null ? null : oneLine(firstText));
  const taskSource = meta?.description ? 'meta' : task === null ? null : 'first-text';

  return {
    agentId: subagent.agentId,
    file: subagent.file,
    workflowRunId: subagent.workflowRunId,
    agentType: meta?.agentType ?? null,
    name: meta?.name ?? null,
    task,
    taskSource,
    toolUseId: meta?.toolUseId ?? null,
    models: [...models],
    startedAt,
    endedAt,
    durationMs:
      startedAt !== null && endedAt !== null
        ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt))
        : null,
    records: stats.parsed,
  };
}
