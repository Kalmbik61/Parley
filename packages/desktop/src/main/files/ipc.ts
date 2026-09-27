/**
 * Каналы `files:*` (спека 10.7, куски 5.2, 7.1a и 7.1b). Все будущие каналы группы
 * регистрирует этот модуль. Аргументы проверяются до обращения к диску и к git:
 * рендереру путь, запрос и ревизию без проверки main не доверяется (спека 15.2).
 * Подписки слежения и поиски принадлежат окну: перезагрузка и закрытие их снимают.
 */
import type { Worker } from 'node:worker_threads';
import type { IpcMain } from 'electron';
import type { FileRoot, GrepQuery } from '../../shared/files-types.js';
import { HostError } from '../host-connection.js';
import { isValidPathArg, isValidWorkKey, withIpcError } from '../ipc.js';
import type { RootsRegistry } from '../roots.js';
import { createFsApi, LIMITS, MAX_PATHS_PER_CALL } from './fs-api.js';
import { createGitApi, isSafeRev, type GitRunner } from './git-api.js';
import { createFileWatch, type WatchFs, type WatchSink } from './watch.js';

/** Запрос поиска — до 1000 символов (план). */
export const MAX_GREP_TEXT = 1000;
/** Id подписки и `signalId` — до 128 символов (план). */
export const MAX_SIGNAL_ID = 128;

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

/** Непустой, до 1000 символов, без NUL (его не пропустит argv git); флаги — булевы. */
function isGrepQuery(value: unknown): value is GrepQuery {
  return (
    isRecord(value) &&
    typeof value.text === 'string' &&
    value.text.length > 0 &&
    value.text.length <= MAX_GREP_TEXT &&
    !value.text.includes('\0') &&
    typeof value.caseSensitive === 'boolean' &&
    typeof value.wholeWord === 'boolean' &&
    typeof value.regex === 'boolean'
  );
}

function isSignalId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_SIGNAL_ID;
}

/** Нужное от `webContents` окна-отправителя. */
interface SenderLike {
  id: number;
  send(channel: string, payload: unknown): void;
  isDestroyed(): boolean;
  on(event: 'did-start-navigation', listener: (details: { isMainFrame: boolean; isSameDocument: boolean }) => void): unknown;
  on(event: 'destroyed', listener: () => void): unknown;
}

/** Что окно открыло: снимается при его перезагрузке и закрытии. */
interface Owner {
  sender: SenderLike;
  watchIds: Set<string>;
  /** signalId окна → метка поиска: второй поиск с тем же id не теряет запись первого. */
  signals: Map<string, object>;
  /** Растёт на каждую перезагрузку: `watch`, завершившийся после неё, снимается сразу. */
  epoch: number;
  sink: WatchSink;
}

export interface RegisterFilesIpcOptions {
  ipcMain: IpcMain;
  roots: RootsRegistry;
  /** git с PATH login-shell (`createGitRunner(shellEnv.env)` в `main/index.ts`). */
  git: GitRunner;
  /** Воркер поиска: в сборке — `?nodeWorker` electron-vite. */
  spawnGrepWorker: () => Worker;
  /** Подставной `fs.watch` для тестов. */
  watchFs?: WatchFs;
}

export function registerFilesIpc({ ipcMain, roots, git, spawnGrepWorker, watchFs }: RegisterFilesIpcOptions): void {
  const watch = createFileWatch({
    roots,
    ...(watchFs === undefined ? {} : { watchFs }),
    onTreeInvalidate: (key) => gitApi.invalidate(key),
  });
  const gitApi = createGitApi({ git, roots, spawnWorker: spawnGrepWorker, isTreeWatched: (key) => watch.isTreeWatched(key) });
  const api = createFsApi(roots, { checkIgnored: gitApi.checkIgnored });
  const owners = new WeakMap<object, Owner>();

  /** signalId в общем реестре — с id окна: одно окно не отменит поиск другого. */
  const signalKey = (owner: Owner, signalId: string): string => `${owner.sender.id}\n${signalId}`;

  const release = (owner: Owner): void => {
    owner.epoch += 1;
    for (const id of owner.watchIds) watch.unwatch(id);
    owner.watchIds.clear();
    for (const signalId of owner.signals.keys()) gitApi.cancel(signalKey(owner, signalId));
    owner.signals.clear();
  };

  const ownerOf = (event: unknown): Owner => {
    const sender = (event as { sender?: SenderLike } | null)?.sender;
    if (sender === undefined) throw new Error('files: event without sender');
    let owner = owners.get(sender);
    if (owner !== undefined) return owner;
    const send = (channel: string, payload: unknown): void => {
      if (!sender.isDestroyed()) sender.send(channel, payload);
    };
    const created: Owner = {
      sender,
      watchIds: new Set(),
      signals: new Map(),
      epoch: 0,
      sink: { changed: (e) => send('files:changed', e), treeChanged: (e) => send('files:tree-changed', e) },
    };
    // Иначе после перезагрузки копились бы наблюдатели и процессы git прежней страницы.
    sender.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) release(created);
    });
    sender.on('destroyed', () => release(created));
    owners.set(sender, created);
    owner = created;
    return owner;
  };

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

  ipcMain.handle(
    'files:watch',
    withIpcError(async (event, root: unknown, relPath: unknown) => {
      if (!isFileRoot(root)) throw new HostError('bad_request', 'invalid file root');
      if (!isValidPathArg(relPath)) throw new HostError('bad_request', 'invalid path');
      const owner = ownerOf(event);
      const epoch = owner.epoch;
      const id = await watch.watch(root, relPath, owner.sink);
      // Страница перезагрузилась, пока слежение запускалось: подписка уже никому не нужна.
      if (owner.epoch !== epoch || owner.sender.isDestroyed()) watch.unwatch(id);
      else owner.watchIds.add(id);
      return id;
    }),
  );

  ipcMain.handle(
    'files:unwatch',
    withIpcError(async (event, id: unknown) => {
      if (!isSignalId(id)) throw new HostError('bad_request', 'invalid watch id');
      const owner = ownerOf(event);
      // Чужую подписку окно не снимает: id другого окна для него — просто незнакомый.
      if (!owner.watchIds.delete(id)) return;
      watch.unwatch(id);
    }),
  );

  ipcMain.handle(
    'files:ls-files',
    withIpcError(async (_event, root: unknown) => {
      if (!isFileRoot(root)) throw new HostError('bad_request', 'invalid file root');
      return gitApi.lsFiles(root);
    }),
  );

  ipcMain.handle(
    'files:grep',
    withIpcError(async (event, root: unknown, query: unknown, signalId: unknown) => {
      if (!isFileRoot(root)) throw new HostError('bad_request', 'invalid file root');
      if (!isGrepQuery(query)) throw new HostError('bad_request', 'invalid grep query');
      if (!isSignalId(signalId)) throw new HostError('bad_request', 'invalid signal id');
      const owner = ownerOf(event);
      const mark = {};
      owner.signals.set(signalId, mark);
      try {
        return await gitApi.grep(root, query, signalKey(owner, signalId));
      } finally {
        if (owner.signals.get(signalId) === mark) owner.signals.delete(signalId);
      }
    }),
  );

  ipcMain.handle(
    'files:cancel',
    withIpcError(async (event, signalId: unknown) => {
      if (!isSignalId(signalId)) throw new HostError('bad_request', 'invalid signal id');
      gitApi.cancel(signalKey(ownerOf(event), signalId));
    }),
  );

  ipcMain.handle(
    'files:git-show',
    withIpcError(async (_event, root: unknown, rev: unknown, relPath: unknown) => {
      if (!isFileRoot(root)) throw new HostError('bad_request', 'invalid file root');
      if (typeof rev !== 'string' || !isSafeRev(rev)) throw new HostError('bad_request', 'invalid revision');
      if (!isValidPathArg(relPath)) throw new HostError('bad_request', 'invalid path');
      return gitApi.gitShow(root, rev, relPath);
    }),
  );

  ipcMain.handle(
    'files:git-status',
    withIpcError(async (_event, root: unknown) => {
      if (!isFileRoot(root)) throw new HostError('bad_request', 'invalid file root');
      return gitApi.gitStatus(root);
    }),
  );
}
