import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readSessionWorkflows, readWorkflowDescriptor } from './workflow.js';

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
