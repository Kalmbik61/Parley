import { mkdtemp, rm } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { addRoom, createWork, readMap, updateMap } from '@parley/core';
import type { RequestInfo } from '../context.js';
import { startHost } from '../host.js';
import { createWorksDelete } from '../methods/works.js';
import { removeHome, tempHome } from '../../test/helpers.js';
const observed = vi.hoisted(() => ({ starts: 0, stops: 0, ready: false }));
vi.mock('./history-service.js', async original => {
  const actual = await original<typeof import('./history-service.js')>();
  return { ...actual, createHistoryService: (works: Parameters<typeof actual.createHistoryService>[0]) => ({
    start: () => { observed.starts++; observed.ready = works.snapshot().entries.length > 0; },
    stop: () => { observed.stops++; },
    removeWork: vi.fn(async () => undefined),
  }) };
});
const projects: string[] = [];
afterEach(async () => { await Promise.all(projects.splice(0).map(p => rm(p, { recursive: true, force: true }))); observed.starts = 0; observed.stops = 0; observed.ready = false; });
async function fixture() {
  const project = await mkdtemp('/private/tmp/parley-history-wiring-'); projects.push(project);
  const map = await createWork(project, { title: 'History fixture', goal: 'Delete safely' });
  await updateMap(project, map.work.id, current => { addRoom(current, { title: 'First', creator: 'human', members: [] }); addRoom(current, { title: 'Second', creator: 'human', members: [] }); });
  return { projectPath: project, workId: map.work.id };
}
it('starts one history service after works are ready and stops it on host shutdown', async () => {
  const home = await tempHome(); vi.stubEnv('PARLEY_HOME', home); await fixture(); const running = await startHost({ home });
  try { expect(observed.starts).toBe(1); expect(observed.ready).toBe(true); }
  finally { await running.context.shutdown('test-cleanup'); await running.closed; await removeHome(home); vi.unstubAllEnvs(); }
  expect(observed.stops).toBe(1);
});
it('passes captured room identities to history cleanup only after committed deletion', async () => {
  const params = await fixture(); const seen: string[][] = [];
  const removeWork = vi.fn(async (projectPath: string, workId: string, roomIds: readonly string[]) => { await expect(readMap(projectPath, workId)).rejects.toBeDefined(); seen.push([...roomIds]); });
  const result = await createWorksDelete({ removeWork })(params, {} as RequestInfo);
  expect(result).toEqual({ ok: true }); expect(seen).toEqual([['r-01', 'r-02']]); expect(removeWork).toHaveBeenCalledTimes(1);
});
it('a derivative cleanup failure does not undo committed workspace deletion', async () => {
  const params = await fixture(); const removeWork = vi.fn(async () => { throw new Error('safe fixture'); });
  await expect(createWorksDelete({ removeWork })(params, {} as RequestInfo)).resolves.toEqual({ ok: true });
  await expect(readMap(params.projectPath, params.workId)).rejects.toBeDefined(); expect(removeWork).toHaveBeenCalledOnce();
});
