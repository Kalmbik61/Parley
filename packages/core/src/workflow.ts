import { readdir, readFile, stat } from 'node:fs/promises';
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

// ---------------------------------------------------------------------------
// Запуски workflow: строки транскрипта + дескриптор + журнал (спека 4.1).
// ---------------------------------------------------------------------------

export type WorkflowRunStatus = 'running' | 'completed' | 'failed' | 'killed' | 'stopped' | 'interrupted';
export type WorkflowAgentState = 'running' | 'done' | 'failed' | 'stopped';

/** Запись о запуске из транскрипта сессии: строка запуска и (если пришла) строка конца. */
export interface WorkflowLaunch {
  runId: string;
  taskId: string;
  name: string | null;
  summary: string | null;
  /** ISO-время строки запуска. */
  launchedAt: string | null;
  /** Статус из `<task-notification>`; null — конца в транскрипте ещё нет. */
  status: string | null;
  /** ISO-время строки конца. */
  endedAt: string | null;
}

export interface WorkflowRunSummary {
  runId: string;
  name: string | null;
  summary: string | null;
  status: WorkflowRunStatus;
  phase: string | null;
  agents: { total: number; running: number; done: number; failed: number };
  startedAt: number | null;
  endedAt: number | null;
}

export interface WorkflowRun extends WorkflowRunSummary {
  phases: string[];
  agentList: Array<{
    agentId: string;
    label: string;
    phase: string | null;
    state: WorkflowAgentState;
    model: string | null;
    startedAt: number | null;
    durationMs: number | null;
    resultPreview: string | null;
    error: string | null;
  }>;
  result: string | null;
  error: string | null;
}

type WorkflowAgent = WorkflowRun['agentList'][number];

export interface WorkflowLaunchCollector {
  onRecord(raw: Record<string, unknown>): void;
  finish(): WorkflowLaunch[];
  clone(): WorkflowLaunchCollector;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Накопитель строк запуска и конца. Строки запуска и конца могут прийти в разных дочитываниях хвоста,
 * поэтому они хранятся отдельно и сводятся только в `finish`. Состояние копируется в `clone`, записи не мутируются.
 */
class LaunchCollector implements WorkflowLaunchCollector {
  private launches = new Map<string, WorkflowLaunch>();
  private ends = new Map<string, { status: string; endedAt: string | null }>();

  clone(): WorkflowLaunchCollector {
    const copy = new LaunchCollector();
    copy.launches = new Map(this.launches);
    copy.ends = new Map(this.ends);
    return copy;
  }

  private end(content: unknown, at: unknown): void {
    if (typeof content !== 'string' || !content.includes('<task-notification>')) return;
    for (const block of content.matchAll(/<task-notification>([\s\S]*?)(?:<\/task-notification>|$)/g)) {
      const taskId = /<task-id>\s*([^<\s]+)\s*<\/task-id>/.exec(block[1] ?? '')?.[1];
      const status = /<status>\s*([^<\s]+)\s*<\/status>/.exec(block[1] ?? '')?.[1];
      // Строка конца дублируется (queue-operation и user): побеждает первая.
      if (taskId && status && !this.ends.has(taskId)) {
        this.ends.set(taskId, { status, endedAt: typeof at === 'string' ? at : null });
      }
    }
  }

  onRecord(raw: Record<string, unknown>): void {
    if (raw.isSidechain === true) return;
    if (raw.type === 'queue-operation') {
      this.end(raw.content, raw.timestamp);
      return;
    }
    if (raw.type !== 'user') return;
    const launched = record(raw.toolUseResult);
    if (
      launched?.status === 'async_launched' &&
      launched.taskType === 'local_workflow' &&
      typeof launched.runId === 'string' &&
      typeof launched.taskId === 'string' &&
      !this.launches.has(launched.taskId)
    ) {
      this.launches.set(launched.taskId, {
        runId: launched.runId,
        taskId: launched.taskId,
        name: str(launched, 'workflowName'),
        summary: str(launched, 'summary'),
        launchedAt: typeof raw.timestamp === 'string' ? raw.timestamp : null,
        status: null,
        endedAt: null,
      });
    }
    const content = record(raw.message)?.content;
    if (typeof content === 'string') this.end(content, raw.timestamp);
  }

  finish(): WorkflowLaunch[] {
    return [...this.launches.values()].map((launch) => {
      const end = this.ends.get(launch.taskId);
      return end ? { ...launch, status: end.status, endedAt: end.endedAt } : launch;
    });
  }
}

export function createWorkflowLaunchCollector(): WorkflowLaunchCollector {
  return new LaunchCollector();
}

/** Разобранные файлы запусков по `(путь, mtime, size)`: законченный дескриптор больше не читается. */
export interface WorkflowRunsCache {
  descriptors: Map<string, { key: string; value: ParsedDescriptor | null }>;
  journals: Map<string, { key: string; value: ParsedJournal }>;
}

export function createWorkflowRunsCache(): WorkflowRunsCache {
  return { descriptors: new Map(), journals: new Map() };
}

interface ParsedDescriptor {
  name: string | null;
  summary: string | null;
  status: string | null;
  startedAt: number | null;
  endedAt: number | null;
  phases: string[];
  agentList: WorkflowAgent[];
  result: string | null;
  error: string | null;
}

interface ParsedJournal {
  agentList: WorkflowAgent[];
}

const RESULT_CAP = 2000;
const PREVIEW_CAP = 300;

/** Поле бывает и значением, и строкой с JSON: разворачиваем строку, если она разбирается. */
function unwrap(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function list(value: unknown): unknown[] {
  const v = unwrap(value);
  return Array.isArray(v) ? v : [];
}

/** Время бывает миллисекундами или ISO-строкой. */
function ms(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function text(value: unknown, cap: number): string | null {
  if (value === null || value === undefined) return null;
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s === '' || s === undefined ? null : s.slice(0, cap);
}

function parseDescriptor(raw: Record<string, unknown>): ParsedDescriptor {
  const summary = unwrap(raw.summary);
  const phases: string[] = [];
  for (const item of list(raw.phases)) {
    const title = typeof item === 'string' ? item : str(record(item) ?? {}, 'title');
    if (title !== null) phases.push(title);
  }
  const agentList: WorkflowAgent[] = [];
  for (const item of list(raw.workflowProgress)) {
    const p = record(item);
    if (p === null) continue;
    if (p.type === 'workflow_phase') {
      const title = str(p, 'title');
      if (title !== null && !phases.includes(title)) phases.push(title);
      continue;
    }
    if (p.type !== 'workflow_agent' || typeof p.agentId !== 'string') continue;
    // Дескриптор бывает только у законченного запуска: `progress` значит, что агент не дошёл до конца.
    const state: WorkflowAgentState = p.state === 'done' ? 'done' : p.state === 'error' ? 'failed' : 'stopped';
    agentList.push({
      agentId: p.agentId,
      label: str(p, 'label') ?? p.agentId,
      phase: str(p, 'phaseTitle'),
      state,
      model: str(p, 'model'),
      startedAt: ms(p.startedAt),
      durationMs: num(p, 'durationMs'),
      resultPreview: text(p.resultPreview, PREVIEW_CAP),
      error: text(p.error, PREVIEW_CAP),
    });
  }
  const startedAt = num(raw, 'startTime');
  const durationMs = num(raw, 'durationMs');
  return {
    name: str(raw, 'workflowName'),
    summary: typeof summary === 'string' && summary !== '' ? summary : null,
    status: str(raw, 'status'),
    startedAt,
    endedAt: ms(raw.timestamp) ?? (startedAt !== null && durationMs !== null ? startedAt + durationMs : null),
    phases,
    agentList,
    result: text(unwrap(raw.result), RESULT_CAP),
    error: text(raw.error, RESULT_CAP),
  };
}

async function parseJournal(file: string): Promise<ParsedJournal> {
  let body = '';
  try {
    body = await readFile(file, 'utf8');
  } catch {
    return { agentList: [] };
  }
  const dir = path.dirname(file);
  const agents = new Map<string, WorkflowAgent>();
  for (const line of body.split('\n')) {
    let entry: Record<string, unknown> | null;
    try {
      entry = record(JSON.parse(line));
    } catch {
      continue; // пустая или оборванная строка
    }
    if (entry === null) continue;
    const agentId = str(entry, 'agentId') ?? str(entry, 'key');
    if (agentId === null) continue;
    if (entry.type === 'started') {
      let startedAt: number | null = null;
      try {
        startedAt = (await stat(path.join(dir, `agent-${agentId}.meta.json`))).mtimeMs;
      } catch {
        // meta ещё не записан — времени старта нет
      }
      agents.set(agentId, {
        agentId,
        label: str(entry, 'label') ?? agentId,
        phase: str(entry, 'phase'),
        state: 'running',
        model: null,
        startedAt,
        durationMs: null,
        resultPreview: null,
        error: null,
      });
    } else if (entry.type === 'result' || entry.type === 'failed') {
      const agent = agents.get(agentId);
      if (agent === undefined) continue;
      agents.set(
        agentId,
        entry.type === 'result'
          ? { ...agent, state: 'done', resultPreview: text(entry.result, PREVIEW_CAP) }
          : { ...agent, state: 'failed' },
      );
    }
  }
  return { agentList: [...agents.values()] };
}

async function statKey(file: string): Promise<string | null> {
  try {
    const s = await stat(file);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return null;
  }
}

async function dirNames(dir: string, wantDirs: boolean): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.name.startsWith('wf_') && (wantDirs ? e.isDirectory() : e.isFile() && e.name.endsWith('.json')))
      .map((e) => (wantDirs ? e.name : path.basename(e.name, '.json')));
  } catch {
    return [];
  }
}

function summarize(run: WorkflowRun): WorkflowRun {
  const count = (state: WorkflowAgentState): number => run.agentList.filter((a) => a.state === state).length;
  const lastPhase = [...run.agentList].reverse().find((a) => a.phase !== null)?.phase ?? null;
  return {
    ...run,
    phase: lastPhase,
    agents: { total: run.agentList.length, running: count('running'), done: count('done'), failed: count('failed') },
  };
}

/**
 * Собирает запуски сессии: дескриптор законченного, журнал идущего, строки запуска из транскрипта.
 * `live` — жив ли процесс сессии: без дескриптора и без `<task-notification>` запуск `running` или `interrupted`.
 * Новые запуски первыми.
 */
export async function readWorkflowRuns(
  sessionFile: string,
  launches: readonly WorkflowLaunch[],
  { live, cache }: { live: boolean; cache: WorkflowRunsCache },
): Promise<WorkflowRun[]> {
  const base = path.join(path.dirname(sessionFile), path.basename(sessionFile, '.jsonl'));
  const descriptorDir = path.join(base, 'workflows');
  const journalDir = path.join(base, 'subagents', 'workflows');
  const launchByRun = new Map(launches.map((l) => [l.runId, l]));
  const runIds = new Set([
    ...(await dirNames(descriptorDir, false)),
    ...(await dirNames(journalDir, true)),
    ...launchByRun.keys(),
  ]);

  const runs: WorkflowRun[] = [];
  for (const runId of runIds) {
    const launch = launchByRun.get(runId);
    const launchedAt = ms(launch?.launchedAt);
    const notified = launch?.status ?? null;

    const descriptorFile = path.join(descriptorDir, `${runId}.json`);
    const descriptorKey = await statKey(descriptorFile);
    let descriptor: ParsedDescriptor | null = null;
    if (descriptorKey !== null) {
      const cached = cache.descriptors.get(descriptorFile);
      if (cached?.key === descriptorKey) {
        descriptor = cached.value;
      } else {
        try {
          const raw = record(JSON.parse(await readFile(descriptorFile, 'utf8')));
          descriptor = raw === null ? null : parseDescriptor(raw);
        } catch {
          descriptor = null; // файл ещё пишется или битый — как будто его нет
        }
        cache.descriptors.set(descriptorFile, { key: descriptorKey, value: descriptor });
      }
    }

    if (descriptor !== null) {
      runs.push(
        summarize({
          runId,
          name: descriptor.name ?? launch?.name ?? null,
          summary: descriptor.summary ?? launch?.summary ?? null,
          status: (descriptor.status ?? notified ?? (live ? 'running' : 'interrupted')) as WorkflowRunStatus,
          phase: null,
          agents: { total: 0, running: 0, done: 0, failed: 0 },
          startedAt: descriptor.startedAt ?? launchedAt,
          endedAt: descriptor.endedAt ?? ms(launch?.endedAt),
          phases: descriptor.phases,
          agentList: descriptor.agentList,
          result: descriptor.result,
          error: descriptor.error,
        }),
      );
      continue;
    }

    // Дескриптора нет: запуск идёт или оборван. Агентов даёт журнал.
    const journalFile = path.join(journalDir, runId, 'journal.jsonl');
    const journalKey = await statKey(journalFile);
    let journal: ParsedJournal = { agentList: [] };
    if (journalKey !== null) {
      const cached = cache.journals.get(journalFile);
      if (cached?.key === journalKey) {
        journal = cached.value;
      } else {
        journal = await parseJournal(journalFile);
        cache.journals.set(journalFile, { key: journalKey, value: journal });
      }
    }
    const status = (notified ?? (live ? 'running' : 'interrupted')) as WorkflowRunStatus;
    // У неоконченного запуска незаконченные агенты ещё работают, у оконченного — остановлены.
    const agentList = journal.agentList.map((a) =>
      a.state === 'running' && status !== 'running' ? { ...a, state: 'stopped' as const } : a,
    );
    const phases: string[] = [];
    for (const a of agentList) if (a.phase !== null && !phases.includes(a.phase)) phases.push(a.phase);
    runs.push(
      summarize({
        runId,
        name: launch?.name ?? null,
        summary: launch?.summary ?? null,
        status,
        phase: null,
        agents: { total: 0, running: 0, done: 0, failed: 0 },
        startedAt: launchedAt,
        endedAt: ms(launch?.endedAt),
        phases,
        agentList,
        result: null,
        error: null,
      }),
    );
  }

  return runs.sort((a, b) => (b.startedAt ?? -Infinity) - (a.startedAt ?? -Infinity));
}
