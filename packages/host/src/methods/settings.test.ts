import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestInfo } from '../context.js';
import { settingsGet, settingsSet } from './settings.js';

let home = '';
const request = {} as RequestInfo;
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-navigator-settings-'));
  vi.stubEnv('PARLEY_HOME', home);
  for (const key of ['PARLEY_SKILL_NAVIGATOR', 'HARNAS_SKILL_NAVIGATOR', 'PARLEY_AGENT_SKILLS', 'HARNAS_AGENT_SKILLS']) vi.stubEnv(key, undefined);
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); });

describe('typed skill navigator settings', () => {
  it('defaults false and persists independently of agentSkills', async () => {
    expect((await settingsGet({}, request)).config.skillNavigator).toBe(false);
    await settingsSet({ key: 'agentSkills', value: 'false' }, request);
    const enabled = await settingsSet({ key: 'skillNavigator', value: 'true' }, request);
    expect(enabled.config).toMatchObject({ skillNavigator: true, agentSkills: false });
    expect((await settingsGet({}, request)).config.skillNavigator).toBe(true);
    expect((await settingsSet({ key: 'skillNavigator', value: 'false' }, request)).config.skillNavigator).toBe(false);
  });
  it.each(['PARLEY_SKILL_NAVIGATOR', 'HARNAS_SKILL_NAVIGATOR'])('reports %s and keeps env precedence over persisted settings', async variable => {
    vi.stubEnv(variable, '1');
    const current = await settingsGet({}, request);
    expect(current.config.skillNavigator).toBe(true);
    expect(current.locked.skillNavigator).toBe(variable);
    expect((await settingsSet({ key: 'skillNavigator', value: 'false' }, request)).config.skillNavigator).toBe(true);
  });
  it('primary env wins and malformed values are rejected', async () => {
    vi.stubEnv('HARNAS_SKILL_NAVIGATOR', '1');
    vi.stubEnv('PARLEY_SKILL_NAVIGATOR', '0');
    expect(await settingsGet({}, request)).toMatchObject({ config: { skillNavigator: false }, locked: { skillNavigator: 'PARLEY_SKILL_NAVIGATOR' } });
    await expect(settingsSet({ key: 'skillNavigator', value: 'perhaps' }, request)).rejects.toMatchObject({ code: 'bad_request' });
  });
});
