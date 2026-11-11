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
  it('включён по умолчанию, выключается и сохраняется независимо от agentSkills', async () => {
    expect((await settingsGet({}, request)).config.skillNavigator).toBe(true);
    await settingsSet({ key: 'agentSkills', value: 'false' }, request);
    const disabled = await settingsSet({ key: 'skillNavigator', value: 'false' }, request);
    expect(disabled.config).toMatchObject({ skillNavigator: false, agentSkills: false });
    expect((await settingsGet({}, request)).config.skillNavigator).toBe(false);
    expect((await settingsSet({ key: 'skillNavigator', value: 'true' }, request)).config.skillNavigator).toBe(true);
  });
  it.each(['PARLEY_SKILL_NAVIGATOR', 'HARNAS_SKILL_NAVIGATOR'])('reports %s and keeps env precedence over persisted settings', async variable => {
    vi.stubEnv(variable, '0');
    const current = await settingsGet({}, request);
    expect(current.config.skillNavigator).toBe(false);
    expect(current.locked.skillNavigator).toBe(variable);
    expect((await settingsSet({ key: 'skillNavigator', value: 'true' }, request)).config.skillNavigator).toBe(false);
  });
  it('primary env wins and malformed values are rejected', async () => {
    vi.stubEnv('HARNAS_SKILL_NAVIGATOR', '1');
    vi.stubEnv('PARLEY_SKILL_NAVIGATOR', '0');
    expect(await settingsGet({}, request)).toMatchObject({ config: { skillNavigator: false }, locked: { skillNavigator: 'PARLEY_SKILL_NAVIGATOR' } });
    await expect(settingsSet({ key: 'skillNavigator', value: 'perhaps' }, request)).rejects.toMatchObject({ code: 'bad_request' });
  });
});

describe('Code Mode setting (plan T12a, §3)', () => {
  it('ON by default; off goes through the ordered writes and survives the config file being replaced', async () => {
    const { codeModeRequested } = await import('@parley/core');
    const { writeFile } = await import('node:fs/promises');
    expect((await settingsGet({}, request)).config.codeMode).toBe(true);
    const off = await settingsSet({ key: 'codeMode', value: 'false' }, request);
    expect(off).toMatchObject({ codeMode: 'off', config: { codeMode: false } });
    await writeFile(path.join(home, 'config.json'), '{"codeMode":true}');
    expect(await codeModeRequested(path.join(home, 'config.json'))).toBe(false);
    const on = await settingsSet({ key: 'codeMode', value: 'true' }, request);
    expect(on).toMatchObject({ codeMode: 'on', config: { codeMode: true } });
    expect(await codeModeRequested(path.join(home, 'config.json'))).toBe(true);
  });
  it('the environment cannot lock or set it', async () => {
    vi.stubEnv('PARLEY_CODE_MODE', '1');
    await settingsSet({ key: 'codeMode', value: 'false' }, request);
    const current = await settingsGet({}, request);
    expect(current.config.codeMode).toBe(false);
    expect(current.locked).not.toHaveProperty('codeMode');
  });
  it('row written, config.json not: off-next-launch, and the window is shown off, not the stale true', async () => {
    // config.json as a directory: the store row can be written, the config file cannot be replaced.
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(path.join(home, 'config.json'));
    await writeFile(path.join(home, 'config.json', 'keep'), 'x');
    const r = await settingsSet({ key: 'codeMode', value: 'false' }, request);
    expect(r).toMatchObject({ codeMode: 'off-next-launch', config: { codeMode: false } });
    expect((await settingsGet({}, request)).config.codeMode).toBe(false);
  });
  it('settings.get reads the state back from disk, so a partial off shows on open (lead m-7289, R2)', async () => {
    const { writeFile } = await import('node:fs/promises');
    const file = path.join(home, 'config.json');
    expect(await settingsGet({}, request)).toMatchObject({ codeMode: 'on', config: { codeMode: true } });
    // config.json off with no store row: deleting the file would turn it back on.
    await writeFile(file, '{"codeMode":false}');
    expect(await settingsGet({}, request)).toMatchObject({ codeMode: 'off-not-durable', config: { codeMode: false } });
    // Both written.
    await settingsSet({ key: 'codeMode', value: 'false' }, request);
    expect(await settingsGet({}, request)).toMatchObject({ codeMode: 'off', config: { codeMode: false } });
    // The row stands, config.json says on again: off for new launches, running sessions still read on.
    await writeFile(file, '{"codeMode":true}');
    expect(await settingsGet({}, request)).toMatchObject({ codeMode: 'off-next-launch', config: { codeMode: false } });
    await settingsSet({ key: 'codeMode', value: 'true' }, request);
    expect(await settingsGet({}, request)).toMatchObject({ codeMode: 'on', config: { codeMode: true } });
  });
  it('other keys answer as before, with no codeMode field', async () => {
    expect(await settingsSet({ key: 'agentSkills', value: 'false' }, request)).not.toHaveProperty('codeMode');
  });
});
