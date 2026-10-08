import { mkdtemp, mkdir, realpath, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readBacklogSnapshot } from '../methods/backlog.js';
import { addBacklogItem } from '@parley/core';
import type { BacklogSnapshot } from '@parley/protocol';
import { createBacklogService } from './backlog-service.js';
import type { BacklogService, BacklogServiceOptions } from './backlog-service.js';
let root: string;
let services: BacklogService[];
let value: BacklogSnapshot;
let callbacks: Map<string, () => void>;
let handles: { directory: string; close: ReturnType<typeof vi.fn>; error?: (() => void) | undefined }[];
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'parley-backlog-watch-')));
  services = []; callbacks = new Map(); handles = [];
  value = { projectPath: root, sharedProjectPath: root, version: 'v1', file: { relativePath: '.parley/backlog.md', exists: false }, items: [], suggestions: [], rule: 'ask', diagnostics: [] };
});
afterEach(async () => { services.forEach(service => service.close()); await rm(root, { recursive: true, force: true }); });
function service(options: BacklogServiceOptions = {}) {
  const read = vi.fn(async (projectPath: string) => ({ ...value, projectPath }));
  const watchDirectory = vi.fn((directory: string, changed: () => void) => {
    callbacks.set(directory, changed);
    const handle = { directory, close: vi.fn(), error: undefined as (() => void) | undefined };
    handles.push(handle);
    return { close: handle.close, on: (_event: 'error', listener: () => void) => { handle.error = listener; } };
  });
  const result = createBacklogService({ debounceMs: 0, snapshot: read, watchDirectory, ...options }); services.push(result);
  return { result, read, watchDirectory };
}
describe('bounded project backlog subscriptions', () => {
  it('shares one watcher across clients and cleans it up on last unsubscribe/client close/shutdown', async () => {
    const { result, watchDirectory } = service();
    await result.subscribe(root, 'one', vi.fn()); await result.subscribe(root, 'two', vi.fn());
    expect(watchDirectory).toHaveBeenCalledTimes(1); expect(watchDirectory.mock.calls[0]![0]).toBe(root);
    result.unsubscribe(root, 'one'); expect(handles[0]!.close).not.toHaveBeenCalled();
    result.removeClient('two'); expect(handles[0]!.close).toHaveBeenCalledTimes(1);
    await result.subscribe(root, 'three', vi.fn()); result.close(); expect(handles[1]!.close).toHaveBeenCalledTimes(1);
    await expect(result.subscribe(root, 'late', vi.fn())).rejects.toMatchObject({ data: { code: 'backlog-watch-unavailable' } });
  });
  it('coalesces raw OS hints and emits only after rereading the safe snapshot', async () => {
    const { result, read } = service(); const notify = vi.fn(); await result.subscribe(root, 'one', notify);
    callbacks.get(root)!(); callbacks.get(root)!(); callbacks.get(root)!();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2)); expect(notify).not.toHaveBeenCalled();
    value = { ...value, version: 'v2' }; callbacks.get(root)!();
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith({ projectPath: root })); expect(read).toHaveBeenCalledTimes(3);
  });
  it('notifies when only the file choice or TODOS.md presence changes while the version stays the same', async () => {
    const { result, read } = service(); const notify = vi.fn(); await result.subscribe(root, 'one', notify);
    value = { ...value, file: { ...value.file, choice: null, todos: 'TODOS.md' } }; callbacks.get(root)!();
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    value = { ...value, file: { ...value.file, choice: 'todos' } }; callbacks.get(root)!();
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(2)); expect(read).toHaveBeenCalledTimes(3);
  });
  it('arms the newly created state directory and rearms on its inode replacement', async () => {
    const { result, watchDirectory } = service(); await result.subscribe(root, 'one', vi.fn());
    const directory = path.join(root, '.parley'); await mkdir(directory); callbacks.get(root)!();
    await vi.waitFor(() => expect(watchDirectory).toHaveBeenCalledTimes(2));
    const first = handles.find(handle => handle.directory === directory)!;
    await rename(directory, path.join(root, 'previous')); await mkdir(directory); callbacks.get(root)!();
    await vi.waitFor(() => expect(watchDirectory).toHaveBeenCalledTimes(3)); expect(first.close).toHaveBeenCalledTimes(1);
  });
  it('runtime watcher errors are explicitly unavailable and dispose the whole subscription', async () => {
    const { result } = service(); const notify = vi.fn(); await result.subscribe(root, 'one', notify);
    handles[0]!.error!(); expect(notify).toHaveBeenCalledWith({ projectPath: root, unavailable: true });
    expect(handles[0]!.close).toHaveBeenCalledTimes(1);
    callbacks.get(root)!(); await new Promise(resolve => setTimeout(resolve, 5)); expect(notify).toHaveBeenCalledTimes(1);
  });
  it('cannot report live success when setup or a bounded reread fails', async () => {
    const first = service({ watchDirectory: () => { throw new Error('secret raw path'); } });
    const error = await first.result.subscribe(root, 'one', vi.fn()).catch(value => value);
    expect(error.data).toEqual({ code: 'backlog-watch-unavailable' }); expect(error.message).not.toContain('secret');
    const second = service(); const notify = vi.fn(); await second.result.subscribe(root, 'two', notify);
    second.read.mockRejectedValueOnce(new Error('private parser')); callbacks.get(root)!();
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith({ projectPath: root, unavailable: true }));
  });
  it('concurrent first subscriptions share the same watcher and retain all listeners', async () => {
    const { result, watchDirectory } = service(); const a = vi.fn(), b = vi.fn();
    await Promise.all([result.subscribe(root, 'a', a), result.subscribe(root, 'b', b)]);
    expect(watchDirectory).toHaveBeenCalledTimes(1);
    value = { ...value, version: 'v2' }; callbacks.get(root)!();
    await vi.waitFor(() => expect(a).toHaveBeenCalledTimes(1)); expect(b).toHaveBeenCalledTimes(1);
  });
  it('failed/slow superseded reads do not remove the current subscription', async () => {
    let reject!: (error: unknown) => void;
    const { result, read } = service();
    read.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const first = result.subscribe(root, 'same', vi.fn()).catch(value => value);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    const current = vi.fn(); await result.subscribe(root, 'same', current); reject(new Error('old read'));
    await first; value = { ...value, version: 'v2' }; callbacks.get(root)!();
    await vi.waitFor(() => expect(current).toHaveBeenCalledTimes(1)); expect(handles[0]!.close).not.toHaveBeenCalled();
  });
  it('bounds client-project subscriptions and refuses additional requests without dropping existing listeners', async () => {
    const { result } = service();
    for (let index = 0; index < 128; index++) await result.subscribe(root, `client-${index}`, vi.fn());
    await expect(result.subscribe(root, 'overflow', vi.fn())).rejects.toMatchObject({ data: { code: 'backlog-watch-unavailable' } });
    result.removeClient('client-0'); await expect(result.subscribe(root, 'replacement', vi.fn())).resolves.toMatchObject({ projectPath: root });
  }, 30_000);
  it('unsubscribe/client close cancels an in-flight initial read without leaving a late watcher', async () => {
    for (const cancel of ['unsubscribe', 'close'] as const) {
      let resolve!: (snapshot: BacklogSnapshot) => void;
      const { result, read } = service();
      read.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
      const initial = result.subscribe(root, cancel, vi.fn()).catch(error => error);
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
      if (cancel === 'unsubscribe') result.unsubscribe(root, cancel); else result.removeClient(cancel);
      resolve(value);
      expect(await initial).toMatchObject({ data: { code: 'backlog-watch-unavailable' } });
      expect(handles.at(-1)!.close).toHaveBeenCalledTimes(1);
    }
  });
  it('bounds canonical project watchers and frees capacity when a client closes', async () => {
    const { result, watchDirectory } = service({ snapshot: async projectPath => ({ ...value, projectPath, sharedProjectPath: projectPath }) });
    for (let index = 0; index < 33; index++) await mkdir(path.join(root, String(index)));
    for (let index = 0; index < 32; index++) await result.subscribe(path.join(root, String(index)), String(index), vi.fn());
    await expect(result.subscribe(path.join(root, '32'), 'overflow', vi.fn())).rejects.toMatchObject({ data: { code: 'backlog-watch-unavailable' } });
    expect(watchDirectory).toHaveBeenCalledTimes(32);
    result.removeClient('0');
    await result.subscribe(path.join(root, '32'), 'replacement', vi.fn());
    expect(watchDirectory).toHaveBeenCalledTimes(33);
  }, 30_000);

  it('observes an actual agent-first file write with nonrecursive platform watchers', async () => {
    await expect(readBacklogSnapshot(root)).resolves.toMatchObject({ projectPath: root });
    const result = createBacklogService({ debounceMs: 5 }); services.push(result);
    const changed = vi.fn(); const initial = await result.subscribe(root, 'real-client', changed);
    expect(initial.file.exists).toBe(false);
    await addBacklogItem(root, { title: 'Platform watcher fixture' });
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith({ projectPath: root }), { timeout: 3000 });
    result.removeClient('real-client');
  });

  it('keeps canonical subscribers live after the first alias client closes and its requested alias is deleted', async () => {
    const alias = path.join(root, 'alias'); await symlink(root, alias);
    const { result, read, watchDirectory } = service(); const aliasNotify = vi.fn(), canonicalNotify = vi.fn();
    expect((await result.subscribe(alias, 'alias-client', aliasNotify)).projectPath).toBe(alias);
    await result.subscribe(root, 'canonical-client', canonicalNotify);
    expect(watchDirectory).toHaveBeenCalledTimes(1);
    result.removeClient('alias-client'); await rm(alias);
    value = { ...value, version: 'canonical-v2' }; callbacks.get(root)!();
    await vi.waitFor(() => expect(canonicalNotify).toHaveBeenCalledWith({ projectPath: root }));
    expect(canonicalNotify.mock.calls.some(([event]) => event.unavailable)).toBe(false);
    expect(aliasNotify).not.toHaveBeenCalled(); expect(read).toHaveBeenLastCalledWith(root); expect(handles[0]!.close).not.toHaveBeenCalled();
  });

});
