import { describe, expect, it } from 'vitest';
import { createFakeBridge } from './fake-bridge.js';

describe('fake-bridge: files и openPath (кусок 5.2)', () => {
  it('files.locate — null на каждый путь по умолчанию, ответы по сеттеру, журнал locateCalls', async () => {
    const bridge = createFakeBridge();
    const root = { workKey: 'k', spec: { kind: 'project' as const } };
    expect(await bridge.files.locate('k', ['/a', '/b'])).toEqual([null, null]);
    bridge.setLocated('k', '/b', { root, relPath: 'b', stat: { kind: 'file', size: 1, mtimeMs: 0 } });
    expect((await bridge.files.locate('k', ['/a', '/b']))[1]?.relPath).toBe('b');
    expect(await bridge.files.locate('other', ['/b'])).toEqual([null]);
    expect(bridge.locateCalls).toHaveLength(3);
    expect(await bridge.files.stat(root, ['x'])).toEqual([null]);
  });

  it('app.openPath — opened по умолчанию, журналы openedPaths и revealedPaths', async () => {
    const bridge = createFakeBridge();
    expect(await bridge.app.openPath('/a.txt')).toBe('opened');
    bridge.setOpenPathResult('revealed');
    expect(await bridge.app.openPath('/b.command')).toBe('revealed');
    await bridge.app.showInFinder('/c');
    expect(bridge.openedPaths).toEqual(['/a.txt', '/b.command']);
    expect(bridge.revealedPaths).toEqual(['/c']);
  });
});

describe('fake-bridge: files.list, readText, readBytes, write (кусок 7.1a)', () => {
  const root = { workKey: 'k', spec: { kind: 'project' as const } };
  const code = async (promise: Promise<unknown>): Promise<string> =>
    promise.then(
      () => 'resolved',
      (error: { code?: string }) => error.code ?? 'no-code',
    );

  it('по умолчанию: list — [], readText и readBytes — not_found, write — ok с растущим mtimeMs', async () => {
    const bridge = createFakeBridge();
    expect(await bridge.files.list(root, '')).toEqual([]);
    expect(await code(bridge.files.readText(root, 'a.ts'))).toBe('not_found');
    expect(await code(bridge.files.readBytes(root, 'a.png'))).toBe('not_found');
    const first = await bridge.files.write(root, 'a.ts', 'x', null);
    const second = await bridge.files.write(root, 'a.ts', 'y', 5);
    expect(first.ok && second.ok && second.mtimeMs > first.mtimeMs).toBe(true);
    expect(bridge.writes).toEqual([
      { root, path: 'a.ts', text: 'x', expectedMtimeMs: null },
      { root, path: 'a.ts', text: 'y', expectedMtimeMs: 5 },
    ]);
    expect(bridge.readTextCalls).toEqual([{ root, path: 'a.ts' }]);
  });

  it('ответы по сеттерам; отказ — объект с code; conflict — только у следующего write', async () => {
    const bridge = createFakeBridge();
    const entry = { name: 'a.ts', kind: 'file' as const, size: 1, mtimeMs: 1, ignored: false, target: null };
    bridge.setDir(root, '', [entry]);
    bridge.setDir(root, 'gone', { code: 'not_found', message: 'gone' });
    expect(await bridge.files.list(root, '')).toEqual([entry]);
    expect(await code(bridge.files.list(root, 'gone'))).toBe('not_found');
    const file = { text: 'abc', mtimeMs: 7, size: 3, binary: false, utf8: true, readOnlyReason: null };
    bridge.setFile(root, 'a.ts', file);
    bridge.setFile(root, 'big.ts', { code: 'files:too-large', message: 'big' });
    expect(await bridge.files.readText(root, 'a.ts')).toEqual(file);
    expect(await code(bridge.files.readText(root, 'big.ts'))).toBe('files:too-large');
    bridge.setBytes(root, 'a.png', new Uint8Array([1, 2]));
    expect([...(await bridge.files.readBytes(root, 'a.png'))]).toEqual([1, 2]);
    bridge.setWriteConflict(root, 'a.ts', 99);
    expect(await bridge.files.write(root, 'a.ts', 'z', 7)).toEqual({ ok: false, conflict: { mtimeMs: 99 } });
    expect((await bridge.files.write(root, 'a.ts', 'z', 99)).ok).toBe(true);
    expect(bridge.writes).toHaveLength(2);
  });
});

describe('fake-bridge: git, поиск и слежение (кусок 7.1b)', () => {
  const root = { workKey: '/p w-1', spec: { kind: 'project' as const } };
  const query = { text: 'x', caseSensitive: false, wholeWord: false, regex: false };
  const code = (promise: Promise<unknown>): Promise<string> =>
    promise.then(
      () => 'resolved',
      (error: { code?: string }) => error.code ?? 'no-code',
    );

  it('по умолчанию: lsFiles [], grep пусто, gitStatus {}, gitShow null; журналы', async () => {
    const bridge = createFakeBridge();
    expect(await bridge.files.lsFiles(root)).toEqual([]);
    expect(await bridge.files.grep(root, query, 's1')).toEqual({ files: [], truncated: false });
    expect(await bridge.files.gitStatus(root)).toEqual({});
    expect(await bridge.files.gitShow(root, 'HEAD', 'a.ts')).toBeNull();
    await bridge.files.cancel('s1');
    const id = await bridge.files.watch(root, '');
    await bridge.files.unwatch(id);
    expect(bridge.lsFilesCalls).toEqual([root]);
    expect(bridge.gitStatusCalls).toEqual([root]);
    expect(bridge.grepCalls).toEqual([{ root, query, signalId: 's1' }]);
    expect(bridge.cancelCalls).toEqual(['s1']);
    expect(bridge.watchCalls).toEqual([{ root, path: '', id }]);
    expect(bridge.unwatchCalls).toEqual([id]);
  });

  it('сеттеры, отказ слежения и эмиттеры событий', async () => {
    const bridge = createFakeBridge();
    bridge.setLsFiles(root, ['a.ts']);
    bridge.setGitStatus(root, { 'a.ts': 'M' });
    const result = { files: [{ path: 'a.ts', hits: [{ line: 1, text: 'x', ranges: [[0, 1]] as [number, number][] }] }], truncated: true };
    bridge.setGrepResult(result);
    expect(await bridge.files.lsFiles(root)).toEqual(['a.ts']);
    expect(await bridge.files.gitStatus(root)).toEqual({ 'a.ts': 'M' });
    expect(await bridge.files.grep(root, query, 's')).toEqual(result);
    bridge.setGrepResult({ code: 'files:denied', message: 'x' });
    expect(await code(bridge.files.grep(root, query, 's'))).toBe('files:denied');
    bridge.setLsFiles(root, { code: 'failed', message: 'x' });
    expect(await code(bridge.files.lsFiles(root))).toBe('failed');
    bridge.setWatchFails(root);
    expect(await code(bridge.files.watch(root, ''))).toBe('files:watch-failed');

    const changed: unknown[] = [];
    const tree: unknown[] = [];
    const offChanged = bridge.files.onChanged((e) => changed.push(e));
    const offTree = bridge.files.onTreeChanged((e) => tree.push(e));
    bridge.emitFileChanged({ id: 'w1', path: 'a.ts', mtimeMs: 5, deleted: false });
    bridge.emitTreeChanged({ rootKey: '/p w-1 project', dirs: [''] });
    offChanged();
    offTree();
    bridge.emitFileChanged({ id: 'w1', path: 'a.ts', mtimeMs: null, deleted: true });
    expect(changed).toEqual([{ id: 'w1', path: 'a.ts', mtimeMs: 5, deleted: false }]);
    expect(tree).toEqual([{ rootKey: '/p w-1 project', dirs: [''] }]);
  });
});
