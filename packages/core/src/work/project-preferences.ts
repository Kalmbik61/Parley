import { MISSING_SHARED_VERSION, SharedStateError, readSharedFile, sharedProjectPaths, withSharedProjectLock, writeSharedFile } from './store.js';
import type { SharedProjectPaths, SharedWriteOptions } from './store.js';

export type BacklogRule = 'ask' | 'problems' | 'everything';
export interface ProjectPreferences { backlogRule: BacklogRule }
const validRule = (value: unknown): value is BacklogRule => value === 'ask' || value === 'problems' || value === 'everything';

async function preferencesRecord(paths: SharedProjectPaths): Promise<{ value: Record<string, unknown>; version: string; text: string }> {
  const snapshot = await readSharedFile(paths.preferences);
  if (snapshot.version === MISSING_SHARED_VERSION) return { ...snapshot, value: { version: 1 } };
  let value: unknown;
  try { value = JSON.parse(snapshot.text); } catch { throw new SharedStateError('preferences-invalid'); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new SharedStateError('preferences-invalid');
  const record = value as Record<string, unknown>;
  if (record['version'] !== 1 || (record['backlogRule'] !== undefined && !validRule(record['backlogRule'])))
    throw new SharedStateError('preferences-invalid');
  return { ...snapshot, value: record };
}
/** Missing preferences default to problems; malformed saved choices never silently widen permission. */
export async function readPreferencesAt(paths: SharedProjectPaths): Promise<ProjectPreferences> {
  const { value } = await preferencesRecord(paths);
  return { backlogRule: value['backlogRule'] as BacklogRule | undefined ?? 'problems' };
}
export async function readProjectPreferences(projectPath: string, options: SharedWriteOptions = {}): Promise<ProjectPreferences> {
  return readPreferencesAt(await sharedProjectPaths(projectPath, options));
}
export async function setBacklogRule(projectPath: string, rule: BacklogRule, options: SharedWriteOptions = {}): Promise<ProjectPreferences> {
  if (!validRule(rule)) throw new SharedStateError('preferences-invalid');
  const paths = await sharedProjectPaths(projectPath, options);
  return withSharedProjectLock(paths, async () => {
    const before = await preferencesRecord(paths);
    await writeSharedFile(paths.preferences, `${JSON.stringify({ ...before.value, backlogRule: rule }, null, 2)}\n`, before);
    return { backlogRule: rule };
  }, options);
}
