import { describe, expect, it } from 'vitest';
import { contextFromEnv } from './context.js';
const base = { PARLEY_WORK_DIR: '/project/.parley/works/w-0001', PARLEY_SESSION_ID: 's-01' };
describe('navigator launch environment snapshot', () => {
  it('is disabled when absent, exact 1 enables, newer prefix wins', () => {
    expect(contextFromEnv(base).skillNavigator).toBe(false);
    expect(contextFromEnv({ ...base, PARLEY_SKILL_NAVIGATOR: '1' }).skillNavigator).toBe(true);
    expect(contextFromEnv({ ...base, PARLEY_SKILL_NAVIGATOR: '0', HARNAS_SKILL_NAVIGATOR: '1' }).skillNavigator).toBe(false);
    expect(contextFromEnv({ ...base, PARLEY_SKILL_NAVIGATOR: 'true' }).skillNavigator).toBe(false);
  });
  it('preserves the immutable local binding revision without reading global settings', () => {
    expect(contextFromEnv({ ...base, HARNAS_SKILL_NAVIGATOR: '1', HARNAS_NATIVE_CONTEXT_REVISION: 'revision' })).toMatchObject({ skillNavigator: true, nativeContextRevision: 'revision' });
  });
});
describe('reduced skill list launch snapshot', () => {
  it('only the exact 1 marks the list reduced; absent keeps the context unchanged', () => {
    expect(contextFromEnv(base)).not.toHaveProperty('skillListReduced');
    expect(contextFromEnv({ ...base, PARLEY_SKILL_LIST_REDUCED: '1' }).skillListReduced).toBe(true);
    expect(contextFromEnv({ ...base, HARNAS_SKILL_LIST_REDUCED: '1' }).skillListReduced).toBe(true);
    expect(contextFromEnv({ ...base, PARLEY_SKILL_LIST_REDUCED: '0', HARNAS_SKILL_LIST_REDUCED: '1' })).not.toHaveProperty('skillListReduced');
    expect(contextFromEnv({ ...base, PARLEY_SKILL_LIST_REDUCED: 'true' })).not.toHaveProperty('skillListReduced');
  });
});
