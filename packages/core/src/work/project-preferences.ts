import { rm } from 'node:fs/promises';
import path from 'node:path';
import { backlogMode, ensureBacklogIdsInTransaction, mergeBacklogInto, raiseBacklogSeq, saveBacklogLocal, withBacklogTransaction } from './backlog.js';
import { MISSING_SHARED_VERSION, SharedStateError, readSharedFile, sharedProjectPaths, withSharedProjectLock, writeSharedFile } from './store.js';
import type { BacklogFileChoice, SharedDiagnostic, SharedProjectPaths, SharedWriteOptions } from './store.js';

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

/** Файл бэклога проекта (спека 2026-10-07-backlog-todos-file, раздел 5). `.parley` → TODOS.md переносит пункты и удаляет
 * `.parley/backlog.md`; обратно — только выбор, TODOS.md человека не трогается. */
export async function setBacklogFile(projectPath: string, file: BacklogFileChoice, options: SharedWriteOptions = {}): Promise<SharedDiagnostic[]> {
  if (file !== 'state' && file !== 'todos') throw new SharedStateError('preferences-invalid');
  return withBacklogTransaction(projectPath, options, async tx => {
    // Строгое чтение до любых изменений: испорченные настройки — отказ, а не перенос без записи выбора.
    const before = await preferencesRecord(tx.paths);
    let diagnostics: SharedDiagnostic[] = [];
    if (file === 'todos' && tx.paths.backlogChoice !== 'todos') {
      // Сейчас tx.paths.backlog — файл каталога состояния. ID рукописным пунктам — чтобы перенос узнал их и при повторе.
      diagnostics = await ensureBacklogIdsInTransaction(tx, options);
      const source = await readSharedFile(tx.paths.backlog);
      if (source.version !== MISSING_SHARED_VERSION) {
        const targetFile = path.join(tx.paths.context.projectPath, tx.paths.todosFile ?? 'TODOS.md');
        const target = await readSharedFile(targetFile);
        const merged = mergeBacklogInto(target.text, source.text);
        if (merged !== target.text) await writeSharedFile(targetFile, merged, target, await backlogMode(targetFile));
        if ((await readSharedFile(tx.paths.backlog)).version !== source.version) throw new SharedStateError('backlog-conflict');
        await rm(tx.paths.backlog);
      }
    }
    // ID уникальны в обоих файлах. Нечитаемый или непонятный файл не мешает переключению.
    for (const candidate of [path.join(tx.paths.dir, 'backlog.md'), path.join(tx.paths.context.projectPath, tx.paths.todosFile ?? 'TODOS.md')]) {
      try { raiseBacklogSeq(tx.state, (await readSharedFile(candidate)).text); } catch { /* безопасная сторона: только счётчик */ }
    }
    await saveBacklogLocal(tx);
    await writeSharedFile(tx.paths.preferences, `${JSON.stringify({ ...before.value, backlogFile: file }, null, 2)}\n`, before);
    return diagnostics;
  });
}
