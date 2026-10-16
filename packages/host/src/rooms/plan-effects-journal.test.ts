import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HUMAN, PARLEY, addRoom, addSession, createWork, migrateMapToJournal, readMap, resolveProposal, setProposal, updateMap, workPaths,
} from '@parley/core';
import type { WorkMap } from '@parley/core';
import type { WorksService } from '../works/works-service.js';
import { createPlanEffectsService } from './plan-effects.js';

/**
 * Служба эффектов плана на карте-журнале (v3): проход не собирает письма всех журналов. Журналы подменяются каталогами:
 * любое чтение файла журнала, а не его хвоста при необходимости, упало бы с EISDIR.
 */
let home = '';
let project = '';

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-plan-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-plan-project-'));
  process.env.PARLEY_HOME = home;
});

afterEach(async () => {
  delete process.env.PARLEY_HOME;
  await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Работа с принятым планом из двух пунктов у двух разных исполнителей: эффекты — по письму каждому. */
async function plannedWork(): Promise<string> {
  const { work } = await createWork(project, { title: 'Работа', goal: 'Цель' });
  await updateMap(project, work.id, (map) => {
    addSession(map, { provider: 'codex', label: 'Lead', task: 'x' });
    addSession(map, { provider: 'codex', label: 'Owner', task: 'x' });
    addRoom(map, { title: 'Plan', creator: HUMAN, members: ['s-01', 's-02'], mode: 'checklist', lead: 's-01' });
    const proposal = setProposal(map, 'r-01', 's-01', 'Decision', new Date().toISOString(), {
      plan: { mode: 'checklist', goal: 'Done', items: [1, 2].map((id) => ({ id, title: `Item ${id}`, owner: 's-02', scope: 'src' })) },
    });
    resolveProposal(map, 'r-01', proposal.proposalId, 'accept', { rev: proposal.rev, planId: 'pl-01', planRev: 0 });
  });
  expect(await migrateMapToJournal(project, work.id)).toMatchObject({ status: 'migrated' });
  return work.id;
}

function worksOf(workId: string): Pick<WorksService, 'snapshot' | 'entry' | 'onChange'> {
  const entry = { projectPath: project, map: { work: { id: workId } } as unknown as WorkMap };
  return { snapshot: () => ({ entries: [entry], branches: {} }), entry: () => entry, onChange: () => () => {} };
}

const parleyLetters = async (workId: string): Promise<number> =>
  (await readMap(project, workId)).messages.filter((message) => message.from === PARLEY).length;

/** Журнал подменён каталогом: его чтение — EISDIR. */
async function breakJournals(workId: string): Promise<void> {
  const paths = workPaths(project, workId);
  for (const file of [path.join(paths.dir, 'messages.jsonl'), path.join(paths.rooms, 'r-01', 'messages.jsonl')]) {
    await rm(file, { force: true });
    await mkdir(file, { recursive: true });
  }
}

describe('эффекты плана на карте-журнале', () => {
  it('проход без очереди не читает ни одного журнала писем: журналы подменены каталогами', async () => {
    const workId = await plannedWork();
    const service = createPlanEffectsService(worksOf(workId), { messageRate: async () => 100 });
    await service.flush(project, workId);
    expect(await parleyLetters(workId)).toBe(2);

    await breakJournals(workId);
    // Всё отправлено, снимки записаны: очереди нет, и проход обязан обойтись индексом.
    await expect(service.flush(project, workId)).resolves.toMatchObject({ queued: 0 });
    service.stop();
  });

  it('очередь при исчерпанном часовом лимите: письма за час берутся из хвостов журналов, лишнее не уходит', async () => {
    const workId = await plannedWork();
    const service = createPlanEffectsService(worksOf(workId), { messageRate: async () => 1 });
    await service.flush(project, workId);
    expect(await parleyLetters(workId)).toBe(1);
    // Второй проход в тот же час: бюджет исчерпан письмом первого прохода, второе остаётся в очереди.
    await expect(service.flush(project, workId)).resolves.toMatchObject({ queued: 1 });
    expect(await parleyLetters(workId)).toBe(1);
    service.stop();
  });
});
