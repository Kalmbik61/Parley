import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createPendingSession, planLaunch, planResume } from './launch.js';
import { createWork, readMap } from './store.js';

let home: string;
let project: string;
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-kimi-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-kimi-project-'));
  vi.stubEnv('PARLEY_HOME', home);
  vi.stubEnv('PARLEY_SKILL_NAVIGATOR', '0');
  await writeFile(path.join(home, 'providers.json'), JSON.stringify({ kimi: { models: [
    { id: 'beta', label: 'Beta', efforts: ['max'] },
  ] } }));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
});

async function session(choices = {}) {
  const { work } = await createWork(project, { title: 'Kimi', goal: '' });
  const id = await createPendingSession(project, work.id, { provider: 'kimi', label: '', task: 'hello', ...choices });
  return { workId: work.id, session: (await readMap(project, work.id)).sessions.find((item) => item.id === id)! };
}

it('carries explicit choices through ACP metadata rather than CLI arguments', async () => {
  const created = await session({ model: 'beta', effort: 'max' });
  const plan = await planLaunch(project, created.workId, created.session);
  expect(plan.kimiAcp).toMatchObject({ model: 'beta', effort: 'max', prompt: expect.stringContaining('hello') });
  expect(plan.args).not.toContain('beta');
  expect(plan.args).not.toContain('max');
});

it('keeps default choices omitted', async () => {
  const created = await session();
  const plan = await planLaunch(project, created.workId, created.session, { model: null, effort: null });
  expect(plan.kimiAcp).not.toHaveProperty('model');
  expect(plan.kimiAcp).not.toHaveProperty('effort');
  expect(plan.kimiAcp).not.toHaveProperty('kimiPermissionMode');
});

it('lets resumed ACP restore chat choices even if creation choices left the catalog', async () => {
  const created = await session({ model: 'removed', effort: 'max' });
  const plan = await planResume(project, created.workId, { ...created.session, providerSessionId: 'kimi-restored' });
  expect(plan.kimiAcp).toMatchObject({ sessionId: 'kimi-restored' });
  expect(plan.kimiAcp).not.toHaveProperty('model');
  expect(plan.kimiAcp).not.toHaveProperty('effort');
});


it.each(['manual', 'yolo', 'auto'])('persists %s as a creation preference, including a Parley resume without a provider ID', async (kimiPermissionMode) => {
  const created = await session({ kimiPermissionMode });
  expect(created.session.kimiPermissionMode).toBe(kimiPermissionMode);
  for (const makePlan of [planLaunch, planResume]) {
    const plan = await makePlan(project, created.workId, created.session);
    expect(plan.kimiAcp).toMatchObject({ kimiPermissionMode });
    expect(plan.kimiAcp).not.toHaveProperty('sessionId');
  }
  const restored = await planResume(project, created.workId, { ...created.session, providerSessionId: 'kimi-restored' });
  expect(restored.kimiAcp).not.toHaveProperty('kimiPermissionMode');
});
