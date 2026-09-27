/**
 * Каналы `files:*` (спека 10.7, кусок 5.2). Все будущие каналы группы регистрирует
 * этот модуль. Аргументы проверяются до обращения к диску: рендереру путь без
 * проверки main не доверяется.
 */
import type { IpcMain } from 'electron';
import type { FileRoot } from '../../shared/files-types.js';
import { HostError } from '../host-connection.js';
import { isValidPathArg, isValidWorkKey, withIpcError } from '../ipc.js';
import type { RootsRegistry } from '../roots.js';
import { createFsApi, MAX_PATHS_PER_CALL } from './fs-api.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `{ workKey, spec }`, где spec — `{ kind: 'project' }` или `{ kind: 'worktree', sessionId }` с непустым sessionId. */
export function isFileRoot(value: unknown): value is FileRoot {
  if (!isRecord(value) || !isValidWorkKey(value.workKey) || !isRecord(value.spec)) return false;
  const spec = value.spec;
  if (spec.kind === 'project') return true;
  return spec.kind === 'worktree' && typeof spec.sessionId === 'string' && spec.sessionId.length > 0;
}

function isPathList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_PATHS_PER_CALL && value.every(isValidPathArg);
}

export interface RegisterFilesIpcOptions {
  ipcMain: IpcMain;
  roots: RootsRegistry;
}

export function registerFilesIpc({ ipcMain, roots }: RegisterFilesIpcOptions): void {
  const api = createFsApi(roots);

  ipcMain.handle(
    'files:stat',
    withIpcError(async (_event, root: unknown, paths: unknown) => {
      if (!isFileRoot(root)) throw new HostError('bad_request', 'invalid file root');
      if (!isPathList(paths)) throw new HostError('bad_request', 'invalid path list');
      return api.stat(root, paths);
    }),
  );

  ipcMain.handle(
    'files:locate',
    withIpcError(async (_event, workKey: unknown, absPaths: unknown) => {
      if (!isValidWorkKey(workKey)) throw new HostError('bad_request', 'invalid work key');
      if (!isPathList(absPaths)) throw new HostError('bad_request', 'invalid path list');
      return api.locate(workKey, absPaths);
    }),
  );
}
