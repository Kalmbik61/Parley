/**
 * Кусок 8.3, тест 1: стороны файла вкладки диффа — ветка (`mergeBase` ↔ диск), коммит (`hash^` ↔
 * `hash`), A, D, R, корневой коммит, сессия без worktree и предел 1 МБ.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { DiffFile, FileRoot, TextFile } from '../../shared/files-types.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { DIFF_LIMITS, loadSides } from './diff-sides.js';

const WT: FileRoot = { workKey: '/tmp/proj w-a', spec: { kind: 'worktree', sessionId: 's-02' } };
const PROJECT: FileRoot = { workKey: '/tmp/proj w-a', spec: { kind: 'project' } };
const BASE = 'a'.repeat(40);
const HASH = 'b'.repeat(40);

function text(value: string, extra: Partial<TextFile> = {}): TextFile {
  return { text: value, mtimeMs: 1, size: value.length, binary: false, utf8: true, readOnlyReason: null, ...extra };
}

function file(path: string, status: DiffFile['status'] = 'M', oldPath: string | null = null): DiffFile {
  return { path, status, oldPath, additions: 1, deletions: 1 };
}

let bridge: FakeBridge;

beforeEach(() => {
  bridge = createFakeBridge();
});

describe('loadSides (тест 1)', () => {
  it('M — gitShow(mergeBase) и readText', async () => {
    bridge.setGitShow(WT, BASE, 'src/a.ts', text('old\n'));
    bridge.setFile(WT, 'src/a.ts', text('new\n'));
    const sides = await loadSides({ files: bridge.files, root: WT, file: file('src/a.ts'), mode: { kind: 'branch', base: BASE } });
    expect(sides).toEqual({ original: 'old\n', modified: 'new\n', tooLarge: false, binary: false });
    expect(bridge.gitShowCalls).toEqual([{ root: WT, rev: BASE, path: 'src/a.ts' }]);
    expect(bridge.readTextCalls).toEqual([{ root: WT, path: 'src/a.ts' }]);
  });

  it('A — original: null, gitShow не зовётся', async () => {
    bridge.setFile(WT, 'n.ts', text('fresh\n'));
    const sides = await loadSides({ files: bridge.files, root: WT, file: file('n.ts', 'A'), mode: { kind: 'branch', base: BASE } });
    expect(sides).toEqual({ original: null, modified: 'fresh\n', tooLarge: false, binary: false });
    expect(bridge.gitShowCalls).toEqual([]);
  });

  it('D — modified: null, readText не зовётся', async () => {
    bridge.setGitShow(WT, BASE, 'gone.ts', text('was\n'));
    const sides = await loadSides({ files: bridge.files, root: WT, file: file('gone.ts', 'D'), mode: { kind: 'branch', base: BASE } });
    expect(sides).toEqual({ original: 'was\n', modified: null, tooLarge: false, binary: false });
    expect(bridge.readTextCalls).toEqual([]);
  });

  it('R — gitShow по oldPath', async () => {
    bridge.setGitShow(WT, BASE, 'old.ts', text('same\n'));
    bridge.setFile(WT, 'new.ts', text('same!\n'));
    const sides = await loadSides({ files: bridge.files, root: WT, file: file('new.ts', 'R', 'old.ts'), mode: { kind: 'branch', base: BASE } });
    expect(sides.original).toBe('same\n');
    expect(bridge.gitShowCalls).toEqual([{ root: WT, rev: BASE, path: 'old.ts' }]);
  });

  it('режим коммита — hash^ и hash, диск не читается', async () => {
    bridge.setGitShow(WT, `${HASH}^`, 'a.ts', text('before\n'));
    bridge.setGitShow(WT, HASH, 'a.ts', text('after\n'));
    const sides = await loadSides({ files: bridge.files, root: WT, file: file('a.ts'), mode: { kind: 'commit', hash: HASH } });
    expect(sides).toEqual({ original: 'before\n', modified: 'after\n', tooLarge: false, binary: false });
    expect(bridge.gitShowCalls.map((call) => call.rev).sort()).toEqual([HASH, `${HASH}^`].sort());
    expect(bridge.readTextCalls).toEqual([]);
  });

  it('корневой коммит: gitShow(<hash>^) → null — original: null', async () => {
    bridge.setGitShow(WT, HASH, 'a.ts', text('first\n'));
    const sides = await loadSides({ files: bridge.files, root: WT, file: file('a.ts', 'A'), mode: { kind: 'commit', hash: HASH } });
    expect(sides).toEqual({ original: null, modified: 'first\n', tooLarge: false, binary: false });
    // У M корневого коммита не бывает, но и тогда null родителя — пустая сторона, а не ошибка.
    const m = await loadSides({ files: bridge.files, root: WT, file: file('a.ts'), mode: { kind: 'commit', hash: HASH } });
    expect(m.original).toBeNull();
    expect(bridge.gitShowCalls).toContainEqual({ root: WT, rev: `${HASH}^`, path: 'a.ts' });
  });

  it('сессия без worktree — original из gitShow(HEAD) корня проекта', async () => {
    bridge.setGitShow(PROJECT, 'HEAD', 'a.ts', text('head\n'));
    bridge.setFile(PROJECT, 'a.ts', text('disk\n'));
    const sides = await loadSides({ files: bridge.files, root: PROJECT, file: file('a.ts'), mode: { kind: 'branch', base: 'HEAD' } });
    expect(sides).toEqual({ original: 'head\n', modified: 'disk\n', tooLarge: false, binary: false });
  });

  it('2 МБ → tooLarge, текст есть (для «Show anyway»); отказ files:too-large → tooLarge без текста', async () => {
    const big = 'x'.repeat(2 * 1024 * 1024);
    bridge.setGitShow(WT, BASE, 'big.txt', text('small\n'));
    bridge.setFile(WT, 'big.txt', text(big, { readOnlyReason: 'too-large' }));
    const sides = await loadSides({ files: bridge.files, root: WT, file: file('big.txt'), mode: { kind: 'branch', base: BASE } });
    expect(sides.tooLarge).toBe(true);
    expect(sides.modified).toBe(big);
    expect(DIFF_LIMITS).toEqual({ maxEditors: 20, maxFileBytes: 1024 * 1024 });

    // Граница: ровно 1 МБ — ещё не большой.
    bridge.setFile(WT, 'edge.txt', text('y'.repeat(1024 * 1024)));
    bridge.setGitShow(WT, BASE, 'edge.txt', text('y\n'));
    expect((await loadSides({ files: bridge.files, root: WT, file: file('edge.txt'), mode: { kind: 'branch', base: BASE } })).tooLarge).toBe(false);

    bridge.setFile(WT, 'huge.bin', { code: 'files:too-large', message: 'x' });
    bridge.setGitShow(WT, BASE, 'huge.bin', text('old\n'));
    const huge = await loadSides({ files: bridge.files, root: WT, file: file('huge.bin'), mode: { kind: 'branch', base: BASE } });
    expect(huge).toEqual({ original: null, modified: null, tooLarge: true, binary: false });
  });

  it('двоичный — binary; прочий отказ — бросается с кодом', async () => {
    bridge.setGitShow(WT, BASE, 'img.png', text('\0', { binary: true }));
    bridge.setFile(WT, 'img.png', text('\0\0', { binary: true }));
    const sides = await loadSides({ files: bridge.files, root: WT, file: file('img.png'), mode: { kind: 'branch', base: BASE } });
    expect(sides.binary).toBe(true);

    bridge.setFile(WT, 'lost.ts', { code: 'not_found', message: 'x' });
    await expect(loadSides({ files: bridge.files, root: WT, file: file('lost.ts', 'A'), mode: { kind: 'branch', base: BASE } })).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
