import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createWorkflowLaunchCollector,
  createWorkflowRunsCache,
  readSessionWorkflows,
  readWorkflowDescriptor,
  readWorkflowRuns,
  type WorkflowLaunch,
} from './workflow.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'parley-wf-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function descriptor(sessionId: string, runId: string, body: unknown): Promise<string> {
  const dir = path.join(root, '-proj', sessionId, 'workflows');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${runId}.json`);
  await writeFile(file, JSON.stringify(body));
  return file;
}

describe('readWorkflowDescriptor', () => {
  it('вытаскивает имя, статус, число агентов и длительность', async () => {
    const file = await descriptor('s1', 'wf_abc', {
      runId: 'wf_abc',
      workflowName: 'course-audit',
      status: 'completed',
      agentCount: 12,
      durationMs: 300_000,
      script: 'export const meta = …',
    });

    expect(await readWorkflowDescriptor(file)).toEqual({
      runId: 'wf_abc',
      name: 'course-audit',
      status: 'completed',
      agentCount: 12,
      durationMs: 300_000,
    });
  });

  it('неполный дескриптор отдаёт null в полях, а не падает', async () => {
    const file = await descriptor('s1', 'wf_abc', { runId: 'wf_abc' });
    expect(await readWorkflowDescriptor(file)).toEqual({
      runId: 'wf_abc',
      name: null,
      status: null,
      agentCount: null,
      durationMs: null,
    });
  });

  it('битый JSON и отсутствующий файл дают null', async () => {
    const dir = path.join(root, '-proj', 's1', 'workflows');
    await mkdir(dir, { recursive: true });
    const broken = path.join(dir, 'wf_broken.json');
    await writeFile(broken, '{не json');

    expect(await readWorkflowDescriptor(broken)).toBeNull();
    expect(await readWorkflowDescriptor(path.join(dir, 'нет.json'))).toBeNull();
  });

  it('runId берётся из имени файла, если его нет внутри', async () => {
    const file = await descriptor('s1', 'wf_из-имени', { workflowName: 'x' });
    expect((await readWorkflowDescriptor(file))?.runId).toBe('wf_из-имени');
  });
});

describe('readSessionWorkflows', () => {
  it('собирает все запуски сессии', async () => {
    await descriptor('s1', 'wf_one', { workflowName: 'первый', status: 'completed' });
    await descriptor('s1', 'wf_two', { workflowName: 'второй', status: 'failed' });

    const found = await readSessionWorkflows(path.join(root, '-proj', 's1.jsonl'));

    expect([...found.keys()].sort()).toEqual(['wf_one', 'wf_two']);
    expect(found.get('wf_one')?.name).toBe('первый');
    expect(found.get('wf_two')?.status).toBe('failed');
  });

  it('посторонние файлы в каталоге игнорируются', async () => {
    await descriptor('s1', 'wf_one', { workflowName: 'нужный' });
    const dir = path.join(root, '-proj', 's1', 'workflows');
    await writeFile(path.join(dir, 'заметка.txt'), 'мимо');
    await writeFile(path.join(dir, 'другое.json'), '{}');

    const found = await readSessionWorkflows(path.join(root, '-proj', 's1.jsonl'));
    expect([...found.keys()]).toEqual(['wf_one']);
  });

  it('сессия без workflow даёт пустую карту', async () => {
    await mkdir(path.join(root, '-proj'), { recursive: true });
    expect((await readSessionWorkflows(path.join(root, '-proj', 's9.jsonl'))).size).toBe(0);
  });
});

const SESSION = () => path.join(root, '-proj', 's1.jsonl');

async function journal(runId: string, lines: unknown[], metas: Record<string, number> = {}): Promise<void> {
  const dir = path.join(root, '-proj', 's1', 'subagents', 'workflows', runId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'journal.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  for (const [agentId, mtime] of Object.entries(metas)) {
    const meta = path.join(dir, `agent-${agentId}.meta.json`);
    await writeFile(meta, '{}');
    await utimes(meta, mtime / 1000, mtime / 1000);
  }
}

function launch(over: Partial<WorkflowLaunch> = {}): WorkflowLaunch {
  return {
    runId: 'wf_run',
    taskId: 'task1',
    name: 'audit',
    summary: 'проверка курса',
    launchedAt: '2026-11-04T10:00:00.000Z',
    status: null,
    endedAt: null,
    ...over,
  };
}

const JOURNAL = [
  { type: 'launched' },
  { type: 'started', key: 'k1', agentId: 'a1', label: 'Первый', phase: 'Сбор' },
  { type: 'started', key: 'k2', agentId: 'a2', label: 'Второй', phase: 'Сбор' },
  { type: 'started', key: 'k3', agentId: 'a3', label: 'Третий', phase: 'Разбор' },
  { type: 'result', key: 'k1', agentId: 'a1', result: 'итог первого', toolsUsed: 2 },
  { type: 'failed', key: 'k2', agentId: 'a2' },
];

describe('readWorkflowRuns', () => {
  it('законченный запуск берётся из дескриптора (фазы и прогресс — строкой JSON)', async () => {
    await descriptor('s1', 'wf_run', {
      workflowName: 'course-audit',
      summary: JSON.stringify('аудит курса'),
      status: 'completed',
      startTime: 1_000_000,
      timestamp: new Date(1_300_000).toISOString(),
      durationMs: 300_000,
      phases: JSON.stringify([{ title: 'Сбор', detail: '', model: 'sonnet' }, { title: 'Разбор' }]),
      result: JSON.stringify({ ok: true }),
      script: 'x'.repeat(50_000),
      workflowProgress: JSON.stringify([
        { type: 'workflow_phase', index: 0, title: 'Сбор' },
        { type: 'workflow_agent', agentId: 'a1', label: 'Первый', phaseIndex: 0, phaseTitle: 'Сбор', model: 'sonnet', state: 'done', startedAt: 1_000_500, durationMs: 4000, resultPreview: 'ok' },
        { type: 'workflow_agent', agentId: 'a2', label: 'Второй', phaseIndex: 1, phaseTitle: 'Разбор', model: 'opus', state: 'error', startedAt: 1_001_000, durationMs: 100, error: 'boom' },
      ]),
    });

    const [run] = await readWorkflowRuns(SESSION(), [], { live: false, cache: createWorkflowRunsCache() });

    expect(run).toMatchObject({
      runId: 'wf_run',
      name: 'course-audit',
      summary: 'аудит курса',
      status: 'completed',
      phase: 'Разбор',
      startedAt: 1_000_000,
      endedAt: 1_300_000,
      phases: ['Сбор', 'Разбор'],
      result: '{"ok":true}',
      error: null,
      agents: { total: 2, running: 0, done: 1, failed: 1 },
    });
    expect(run?.agentList[0]).toEqual({
      agentId: 'a1', label: 'Первый', phase: 'Сбор', state: 'done', model: 'sonnet',
      startedAt: 1_000_500, durationMs: 4000, resultPreview: 'ok', error: null,
    });
    expect(run?.agentList[1]).toMatchObject({ state: 'failed', error: 'boom', durationMs: 100 });
  });

  it('массивы вместо строк и отсутствие полей не ломают разбор', async () => {
    await descriptor('s1', 'wf_run', {
      status: 'completed',
      phases: [{ title: 'Сбор' }],
      workflowProgress: [{ type: 'workflow_agent', agentId: 'a1', state: 'done' }],
    });
    const [run] = await readWorkflowRuns(SESSION(), [], { live: false, cache: createWorkflowRunsCache() });
    expect(run).toMatchObject({ name: null, startedAt: null, endedAt: null, result: null, phases: ['Сбор'] });
    expect(run?.agentList[0]).toMatchObject({ agentId: 'a1', label: 'a1', phase: null, model: null });
  });

  it('без дескриптора идущий запуск: имя из строки запуска, агенты по журналу', async () => {
    await journal('wf_run', JOURNAL, { a1: 1_700_000_000_000 });

    const [run] = await readWorkflowRuns(SESSION(), [launch()], { live: true, cache: createWorkflowRunsCache() });

    expect(run).toMatchObject({
      runId: 'wf_run',
      name: 'audit',
      summary: 'проверка курса',
      status: 'running',
      phase: 'Разбор',
      startedAt: Date.parse('2026-11-04T10:00:00.000Z'),
      endedAt: null,
      phases: ['Сбор', 'Разбор'],
      agents: { total: 3, running: 1, done: 1, failed: 1 },
    });
    expect(run?.agentList.map((a) => [a.label, a.state])).toEqual([
      ['Первый', 'done'],
      ['Второй', 'failed'],
      ['Третий', 'running'],
    ]);
    expect(run?.agentList[0]).toMatchObject({ startedAt: 1_700_000_000_000, resultPreview: 'итог первого' });
    expect(run?.agentList[1]?.startedAt).toBeNull(); // meta.json нет
  });

  it('процесс не жив: interrupted, незаконченные агенты stopped; нотификация stopped даёт stopped', async () => {
    await journal('wf_run', JOURNAL);

    const [dead] = await readWorkflowRuns(SESSION(), [launch()], { live: false, cache: createWorkflowRunsCache() });
    expect(dead?.status).toBe('interrupted');
    expect(dead?.agentList.map((a) => a.state)).toEqual(['done', 'failed', 'stopped']);

    const stopped = launch({ status: 'stopped', endedAt: '2026-11-04T11:00:00.000Z' });
    const [run] = await readWorkflowRuns(SESSION(), [stopped], { live: true, cache: createWorkflowRunsCache() });
    expect(run).toMatchObject({ status: 'stopped', endedAt: Date.parse('2026-11-04T11:00:00.000Z') });
    expect(run?.agentList[2]?.state).toBe('stopped');
  });

  it('killed с error и агентом progress: статус killed, агент stopped', async () => {
    await descriptor('s1', 'wf_run', {
      workflowName: 'w',
      status: 'killed',
      error: 'остановлен пользователем',
      workflowProgress: [{ type: 'workflow_agent', agentId: 'a1', label: 'L', state: 'progress' }],
    });
    const [run] = await readWorkflowRuns(SESSION(), [], { live: true, cache: createWorkflowRunsCache() });
    expect(run).toMatchObject({ status: 'killed', error: 'остановлен пользователем' });
    expect(run?.agentList[0]?.state).toBe('stopped');
  });

  it('неизменённый дескриптор берётся из кэша, изменённый перечитывается', async () => {
    const file = await descriptor('s1', 'wf_run', { workflowName: 'aaaa', status: 'completed' });
    const cache = createWorkflowRunsCache();
    const options = { live: false, cache };
    const fixed = new Date(1_700_000_000_000);
    await utimes(file, fixed, fixed);
    expect((await readWorkflowRuns(SESSION(), [], options))[0]?.name).toBe('aaaa');

    // тот же размер и mtime, другое содержимое: если бы файл читался, имя сменилось бы
    await writeFile(file, JSON.stringify({ workflowName: 'bbbb', status: 'completed' }));
    await utimes(file, fixed, fixed);
    expect((await readWorkflowRuns(SESSION(), [], options))[0]?.name).toBe('aaaa');

    await writeFile(file, JSON.stringify({ workflowName: 'cccccc', status: 'completed' }));
    expect((await readWorkflowRuns(SESSION(), [], options))[0]?.name).toBe('cccccc');
  });

  it('сортирует по началу, новые первыми', async () => {
    await descriptor('s1', 'wf_old', { workflowName: 'old', status: 'completed', startTime: 100 });
    await descriptor('s1', 'wf_new', { workflowName: 'new', status: 'completed', startTime: 200 });
    const runs = await readWorkflowRuns(SESSION(), [], { live: false, cache: createWorkflowRunsCache() });
    expect(runs.map((r) => r.name)).toEqual(['new', 'old']);
  });
});

describe('createWorkflowLaunchCollector', () => {
  const launched = {
    type: 'user',
    timestamp: '2026-11-04T10:00:00.000Z',
    toolUseResult: {
      status: 'async_launched', taskType: 'local_workflow', taskId: 'task1', runId: 'wf_run',
      workflowName: 'audit', summary: 'проверка', transcriptDir: '/x', scriptPath: '/y',
    },
  };
  const note = (status: string) =>
    `<task-notification>\n<task-id>task1</task-id>\n<tool-use-id>tu</tool-use-id>\n<status>${status}</status>\n<summary>s</summary>\n</task-notification>`;

  it('строка запуска и строка конца в разных дочитываниях сводятся в одну запись', () => {
    const first = createWorkflowLaunchCollector();
    first.onRecord(launched);
    const snapshot = first.finish();
    expect(snapshot).toEqual([
      { runId: 'wf_run', taskId: 'task1', name: 'audit', summary: 'проверка', launchedAt: '2026-11-04T10:00:00.000Z', status: null, endedAt: null },
    ]);

    // дочитывание: копия переживает хвост, прежнее состояние не мутируется
    const second = first.clone();
    second.onRecord({ type: 'queue-operation', timestamp: '2026-11-04T10:05:00.000Z', content: note('completed') });
    second.onRecord({ type: 'user', timestamp: '2026-11-04T10:05:01.000Z', message: { content: note('completed') } });

    expect(first.finish()).toEqual(snapshot);
    expect(second.finish()).toEqual([
      { ...snapshot[0], status: 'completed', endedAt: '2026-11-04T10:05:00.000Z' },
    ]);
  });

  it('побочные цепочки и чужие записи пропускаются', () => {
    const c = createWorkflowLaunchCollector();
    c.onRecord({ ...launched, isSidechain: true });
    c.onRecord({ type: 'user', toolUseResult: { status: 'async_launched', taskType: 'other', taskId: 't', runId: 'wf_x' } });
    c.onRecord({ type: 'assistant', message: { content: note('failed') } });
    expect(c.finish()).toEqual([]);
  });
});
