/**
 * Каналы `files:*` (спека 10.7, куски 5.2 и 7.1a). Все будущие каналы группы регистрирует
 * этот модуль. Аргументы проверяются до обращения к диску: рендереру путь без
 * проверки main не доверяется.
 */
import type { IpcMain } from 'electron';
import type { FileRoot } from '../../shared/files-types.js';
import { HostError } from '../host-connection.js';
import { isValidPathArg, isValidWorkKey, withIpcError } from '../ipc.js';
import type { RootsRegistry } from '../roots.js';
import { createFsApi, LIMITS, MAX_PATHS_PER_CALL } from './fs-api.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `{ workKey, spec }`, где spec — `{ kind: 'project' }` или `{ kind: 'worktree', sessionId }`. */
export function isFileRoot(value: unknown): value is FileRoot {
  if (!isRecord(value) || !isValidWorkKey(value.workKey) || !isRecord(value.spec)) return false;
  const spec = value.spec;
  if (spec.kind === 'project') return true;
  // Своей проверки id сессии в shared нет, а форма `s-NN` не обязательна (ручные и чужие
  // сессии): те же правила, что у workKey — непустой, не длиннее предела, не имя прототипа.
  return spec.kind === 'worktree' && isValidWorkKey(spec.sessionId);
}

function isPathList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_PATHS_PER_CALL && value.every(isValidPathArg);
}

/** Предел `readBytes`: целое от 1 байта до 20 МБ; `undefined` — по умолчанию 20 МБ. */
function isByteLimit(value: unknown): value is number | undefined {
  return value === undefined || (Number.isInteger(value) && (value as number) >= 1 && (value as number) <= LIMITS.openableBytes);
}

/** `null` — «файла быть не должно»; иначе конечное число. */
function isExpectedMtime(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
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

  ipcMain.handle(
    'files:list',
    withIpcError(async (_event, root: unknown, dir: unknown) => {
      if (!isFileRoot(root)) throw new HostError('bad_request', 'invalid file root');
      if (!isValidPathArg(dir)) throw new HostError('bad_request', 'invalid path');
      return api.list(root, dir);
    }),
  );

  ipcMain.handle(
    'files:read-text',
    withIpcError(async (_event, root: unknown, relPath: unknown) => {
      if (!isFileRoot(root)) throw new HostError('bad_request', 'invalid file root');
      if (!isValidPathArg(relPath)) throw new HostError('bad_request', 'invalid path');
      return api.readText(root, relPath);
    }),
  );

  ipcMain.handle(
    'files:read-bytes',
    withIpcError(async (_event, root: unknown, relPath: unknown, limit: unknown) => {
      if (!isFileRoot(root)) throw new HostError('bad_request', 'invalid file root');
      if (!isValidPathArg(relPath)) throw new HostError('bad_request', 'invalid path');
      if (!isByteLimit(limit)) throw new HostError('bad_request', 'invalid byte limit');
      return api.readBytes(root, relPath, limit);
    }),
  );

  ipcMain.handle(
    'files:write',
    withIpcError(async (_event, root: unknown, relPath: unknown, text: unknown, expectedMtimeMs: unknown) => {
      if (!isFileRoot(root)) throw new HostError('bad_request', 'invalid file root');
      if (!isValidPathArg(relPath)) throw new HostError('bad_request', 'invalid path');
      if (typeof text !== 'string') throw new HostError('bad_request', 'invalid text');
      if (!isExpectedMtime(expectedMtimeMs)) throw new HostError('bad_request', 'invalid expected mtime');
      return api.write(root, relPath, text, expectedMtimeMs);
    }),
  );
}
