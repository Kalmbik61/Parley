import path from 'node:path';
import { forEachJsonlRecord } from './jsonl.js';
import { adapterV1, type SchemaAdapter, type SessionRecord } from './adapter-v1.js';

export type Provider = 'claude' | 'codex' | 'glm';

export interface SessionIndex {
  /** sessionId из записей; если его нет — имя файла. */
  id: string;
  /** Слаг каталога проекта в ~/.claude/projects. */
  project: string;
  /** Абсолютный путь проекта (из cwd записей). */
  projectPath: string | null;
  cwd: string | null;
  gitBranch: string | null;
  version: string | null;
  file: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  records: number;
  malformedLines: number;
  models: Record<string, number>;
  tools: Record<string, number>;
  roles: Record<string, number>;
  recordTypes: Record<string, number>;
  /** Самая частая модель, кроме служебной `<synthetic>`. */
  primaryModel: string | null;
  provider: Provider;
}

/** Не модель, а служебная пометка Claude Code — в бейдже показывать нечего. */
const SYNTHETIC_MODEL = '<synthetic>';

class Counter {
  private readonly counts = new Map<string, number>();

  add(key: string | null): void {
    if (key === null) return;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  /** Записи в порядке убывания частоты — так их и показывает UI. */
  toObject(): Record<string, number> {
    return Object.fromEntries([...this.counts].sort((a, b) => b[1] - a[1]));
  }

  top(exclude: ReadonlySet<string> = new Set()): string | null {
    let best: string | null = null;
    let bestCount = 0;
    for (const [key, count] of this.counts) {
      if (exclude.has(key)) continue;
      if (count > bestCount) {
        best = key;
        bestCount = count;
      }
    }
    return best;
  }
}

/** Слаг проекта = первый сегмент пути относительно корня ~/.claude/projects. */
export function projectSlug(file: string, root: string): string {
  const relative = path.relative(root, file);
  const [first] = relative.split(path.sep);
  return first && first !== '..' ? first : path.basename(path.dirname(file));
}

/**
 * Индексирует ОДИН файл сессии: мета, длительность, счётчики моделей, инструментов,
 * ролей и типов записей. Заголовок и подсессии добавляются отдельно — они требуют
 * данных, которых в самом файле нет (см. specs/data-layer.md).
 */
export async function indexSessionFile(
  file: string,
  root: string,
  adapter: SchemaAdapter = adapterV1,
): Promise<SessionIndex> {
  const models = new Counter();
  const tools = new Counter();
  const roles = new Counter();
  const recordTypes = new Counter();

  let sessionId: string | null = null;
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let version: string | null = null;
  let startedAt: string | null = null;
  let endedAt: string | null = null;

  const stats = await forEachJsonlRecord(file, (raw) => {
    const record: SessionRecord = adapter.toSessionRecord(raw);

    recordTypes.add(record.type);
    models.add(record.model);
    roles.add(record.role);
    for (const tool of record.toolUses) tools.add(tool);

    sessionId ??= record.sessionId;
    cwd ??= record.cwd;
    gitBranch ??= record.gitBranch;
    version ??= record.version;

    // Записи заголовков и служебные идут без timestamp — по ним время не считаем.
    const at = record.timestamp;
    if (at !== null) {
      if (startedAt === null || at < startedAt) startedAt = at;
      if (endedAt === null || at > endedAt) endedAt = at;
    }
  });

  const durationMs =
    startedAt !== null && endedAt !== null
      ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt))
      : null;

  return {
    id: sessionId ?? path.basename(file, '.jsonl'),
    project: projectSlug(file, root),
    projectPath: cwd,
    cwd,
    gitBranch,
    version,
    file,
    startedAt,
    endedAt,
    durationMs,
    records: stats.parsed,
    malformedLines: stats.malformed,
    models: models.toObject(),
    tools: tools.toObject(),
    roles: roles.toObject(),
    recordTypes: recordTypes.toObject(),
    primaryModel: models.top(new Set([SYNTHETIC_MODEL])),
    provider: 'claude',
  };
}
