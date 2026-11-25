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

it('carries explicit model and effort choices into the native launch', async () => {
  const created = await session({ model: 'beta', effort: 'max' });
  const plan = await planLaunch(project, created.workId, created.session);
  expect(plan.deferredPrompt).toContain('hello');
  expect(plan.args).toEqual(['--model', 'beta']);
  expect(plan.env.KIMI_MODEL_THINKING_EFFORT).toBe('max');
  expect(plan.args).not.toContain('max');
});

it('keeps default choices omitted', async () => {
  const created = await session();
  const plan = await planLaunch(project, created.workId, created.session, { model: null, effort: null });
  expect(plan.args).toEqual([]);
  expect(plan.env).not.toHaveProperty('KIMI_MODEL_THINKING_EFFORT');
  expect(plan.kimiNative).not.toHaveProperty('permissionMode');
});

it('lets native exact resume restore choices even if the creation model left the catalog', async () => {
  const created = await session({ model: 'removed', effort: 'max' });
  const plan = await planResume(project, created.workId, { ...created.session, providerSessionId: 'kimi-restored' });
  expect(plan.args).toEqual(['--session', 'kimi-restored']);
  expect(plan.env).not.toHaveProperty('KIMI_MODEL_THINKING_EFFORT');
});


it.each(['manual', 'yolo', 'auto'])('persists %s as a creation preference, including a Parley resume without a provider ID', async (kimiPermissionMode) => {
  const created = await session({ kimiPermissionMode });
  expect(created.session.kimiPermissionMode).toBe(kimiPermissionMode);
  for (const makePlan of [planLaunch, planResume]) {
    const plan = await makePlan(project, created.workId, created.session);
    expect(plan.kimiNative).toMatchObject({ permissionMode: kimiPermissionMode });
    expect(plan.providerSessionId).toBeNull();
  }
  const restored = await planResume(project, created.workId, { ...created.session, providerSessionId: 'kimi-restored' });
  expect(restored.kimiNative).not.toHaveProperty('permissionMode');
});
