import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createWork, deleteWorkFiles, readStoredMap, replaceStoredMap } from '@parley/core';
import type { Room } from '@parley/core';
import { isWorkDeleted } from './history-service.js';

let home = '';
let project = '';

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
  process.env['PARLEY_HOME'] = home;
});

afterEach(async () => {
  delete process.env['PARLEY_HOME'];
  await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
});

it('a work whose row is in the database is not deleted, a removed one is', async () => {
  const { work } = await createWork(project, { title: 'History' });
  expect(await isWorkDeleted(project, work.id)).toBe(false);

  await deleteWorkFiles(project, work.id);

  expect(await isWorkDeleted(project, work.id)).toBe(true);
  expect(await isWorkDeleted(project, 'w-9999')).toBe(true);
});

it('a stored work that normalizeMap rejects is never proof of deletion', async () => {
  const { work } = await createWork(project, { title: 'History' });
  const stored = readStoredMap(project, work.id);
  stored.rooms.push({
    id: 'r-01', title: 'broken', creator: 'human', ownerId: null, members: [], createdAt: '2026-10-24T00:00:00.000Z',
    lead: null, proposal: null, archivedAt: null, mode: 'bogus',
  } as unknown as Room);
  replaceStoredMap(project, work.id, stored);

  expect(await isWorkDeleted(project, work.id)).toBe(false);
});
