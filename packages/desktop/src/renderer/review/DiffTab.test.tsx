/**
 * Кусок 8.3, тесты 2, 3 и 6–11: вкладка диффа на Monaco — предел живых редакторов, колонки,
 * режим коммита, обновление по сигналам «Изменений», переход к файлу, старый хост, сбой Monaco
 * и сессия без worktree. Monaco и `IntersectionObserver` в jsdom нет: оба подменены.
 */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkEntry, WorktreeDiff } from '@harnas/core';
import type { DiffFile, FileRoot, TextFile } from '../../shared/files-types.js';
import type { TabSpec } from '../../shared/layout-types.js';
import { tabId } from '../layout/ids.js';
import { tabMeta } from '../layout/tab-meta.js';
import { REQUIRED_METHODS } from '../lib/capabilities.js';
import { useActivityStore } from '../store/activity.js';
import { useHostStore } from '../store/host.js';
import { useUiStore } from '../store/ui.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { monacoMock } from '../test-utils/monaco-mock.js';
import { makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { DiffTab } from './DiffTab.js';
import { useReviewStore } from './store.js';

vi.mock('@monaco-editor/react', async () => (await import('../test-utils/monaco-mock.js')).monacoReactMock);
vi.mock('../files/editor/monaco-setup.js', async () => (await import('../test-utils/monaco-mock.js')).monacoSetupMock);

const KEY = '/tmp/proj w-a';
const BASE = 'a'.repeat(40);
const HASH = 'b'.repeat(40);
const WORKTREE = { path: '/tmp/wt/s-02', branch: 'harnas/w-a/s02', base: 'master', createdAt: '2026-09-27T08:00:00Z' };
const WT: FileRoot = { workKey: KEY, spec: { kind: 'worktree', sessionId: 's-02' } };
const PROJECT: FileRoot = { workKey: KEY, spec: { kind: 'project' } };

/** Подставной `IntersectionObserver`: пересечения вызывает сам тест. */
class FakeIO {
  static all: FakeIO[] = [];
  readonly targets = new Set<Element>();
  constructor(
    readonly callback: IntersectionObserverCallback,
    readonly options: IntersectionObserverInit | undefined,
  ) {
    FakeIO.all.push(this);
  }
  observe(target: Element): void {
    this.targets.add(target);
  }
  unobserve(target: Element): void {
    this.targets.delete(target);
  }
  disconnect(): void {
    this.targets.clear();
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

function intersect(paths: string[], on = true): void {
  act(() => {
    for (const io of FakeIO.all) {
      const entries = [...io.targets]
        .filter((target) => paths.includes(target.getAttribute('data-diff-path') ?? ''))
        .map((target) => ({ target, isIntersecting: on }) as unknown as IntersectionObserverEntry);
      if (entries.length > 0) io.callback(entries, io as unknown as IntersectionObserver);
    }
  });
}

function text(value: string): TextFile {
  return { text: value, mtimeMs: 1, size: value.length, binary: false, utf8: true, readOnlyReason: null };
}

function file(path: string, status: DiffFile['status'] = 'M'): DiffFile {
  return { path, status, oldPath: null, additions: 1, deletions: 1 };
}

function diff(files: DiffFile[]): WorktreeDiff {
  return {
    patch: '',
    files,
    uncommitted: true,
    baseCheckout: '/tmp/proj',
    baseDirty: false,
    mergeBase: BASE,
    stats: { additions: files.length, deletions: files.length },
    commits: [],
    uncommittedPaths: files.map((f) => f.path),
  };
}

function work(title = 'w-a', sessions = [makeSession('s-02', 'two', { worktree: WORKTREE }), makeSession('s-04', 'four')]): WorkEntry {
  return makeWork('w-a', { projectPath: '/tmp/proj', title, sessions });
}

const diffTab = (sessionId = 's-02', commit: string | null = null): Extract<TabSpec, { kind: 'diff' }> => ({
  kind: 'diff',
  id: tabId.diff(sessionId, commit),
  sessionId,
  commit,
});

let bridge: FakeBridge;

function count(method: string): number {
  return bridge.calls.filter((call) => call.method === method).length;
}

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function section(path: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-diff-path="${path}"]`);
  if (found === null) throw new Error(`нет секции ${path}`);
  return found;
}

function live(): typeof monacoMock.diffEditors {
  return monacoMock.diffEditors.filter((editor) => !editor.disposed);
}

function liveFor(content: string): (typeof monacoMock.diffEditors)[number] | undefined {
  return live().find((editor) => editor.modified.text === content);
}

/** Файл ветки: base — `old <путь>`, диск — `<путь>`. */
function serve(root: FileRoot, path: string, rev = BASE): void {
  bridge.setGitShow(root, rev, path, text(`old ${path}\n`));
  bridge.setFile(root, path, text(`${path}\n`));
}

function renderTab(entry: WorkEntry = work(), tab = diffTab()): ReturnType<typeof render> {
  return render(<DiffTab bridge={bridge} workKey={KEY} entry={entry} tab={tab} />);
}

let scrolled: HTMLElement[];

beforeEach(() => {
  vi.useFakeTimers();
  FakeIO.all = [];
  vi.stubGlobal('IntersectionObserver', FakeIO);
  scrolled = [];
  Element.prototype.scrollIntoView = function scrollIntoView(this: HTMLElement) {
    scrolled.push(this);
  };
  monacoMock.reset();
  bridge = createFakeBridge();
  bridge.setHandler('worktrees.diff', () => diff([]));
  bridge.setHandler('changes.project', () => ({ patch: '', files: [], stats: { additions: 0, deletions: 0 }, branch: 'master' }));
  useHostStore.getState().init(bridge);
  bridge.setHostMethods([...REQUIRED_METHODS]);
  useActivityStore.setState({ byRef: {} });
  useReviewStore.setState({ changesSession: {}, revealed: {}, discarded: {} });
  useUiStore.setState((state) => ({ ui: { ...state.ui, diffView: 'split' } }));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useHostStore.setState({ status: { state: 'connecting' } });
});

describe('DiffTab: ленивость и предел живых редакторов (тест 2)', () => {
  it('30 файлов — живых не больше 20; прокрутка к 25-му монтирует его и освобождает дальний', async () => {
    const names = Array.from({ length: 30 }, (_, i) => `f${String(i).padStart(2, '0')}.ts`);
    bridge.setHandler('worktrees.diff', () => diff(names.map((name) => file(name))));
    for (const name of names) serve(WT, name);
    renderTab();
    await flush();
    // Без пересечений ни одного редактора: секции — заглушки оценочной высоты.
    expect(monacoMock.diffEditors).toHaveLength(0);
    expect(section('f00.ts').querySelector('[data-diff-placeholder]')).not.toBeNull();
    expect(FakeIO.all.at(-1)?.options?.rootMargin).toBe('400px');

    intersect(names.slice(0, 20));
    await flush();
    expect(live()).toHaveLength(20);
    expect(liveFor('f25.ts\n')).toBeUndefined();

    intersect(['f00.ts'], false);
    intersect(['f25.ts']);
    await flush();
    expect(liveFor('f25.ts\n')).toBeDefined();
    expect(liveFor('f00.ts\n')).toBeUndefined();
    expect(live().length).toBeLessThanOrEqual(20);

    intersect(names);
    await flush();
    expect(live().length).toBeLessThanOrEqual(20);
  });
});

describe('DiffTab: свёрнутая секция слота не занимает (раунд 8, пункт 6)', () => {
  it('30 файлов, 10 свёрнуты; прокрутка обратно к свёрнутым — все 20 слотов у развёрнутых видимых файлов', async () => {
    const names = Array.from({ length: 30 }, (_, i) => `f${String(i).padStart(2, '0')}.ts`);
    bridge.setHandler('worktrees.diff', () => diff(names.map((name) => file(name))));
    for (const name of names) serve(WT, name);
    renderTab();
    await flush();

    intersect(names.slice(0, 20));
    await flush();
    for (const name of names.slice(0, 10)) fireEvent.click(within(section(name)).getByRole('button', { name: 'Collapse' }));
    await flush();
    expect(live()).toHaveLength(10);

    // Вниз: свёрнутые ушли из вида, пришли f20–f29 — живы f10–f29.
    intersect(names.slice(0, 10), false);
    intersect(names.slice(20));
    await flush();
    const expanded = names.slice(10);
    for (const name of expanded) expect(liveFor(`${name}\n`)).toBeDefined();

    // Обратно к свёрнутым (все 30 в зоне rootMargin): свёрнутые не вытесняют ни одного развёрнутого.
    intersect(names.slice(0, 10));
    await flush();
    expect(live()).toHaveLength(20);
    for (const name of expanded) expect(liveFor(`${name}\n`)).toBeDefined();

    // Развернули свёрнутую в зоне — она получает слот как обычно.
    fireEvent.click(within(section('f00.ts')).getByRole('button', { name: 'Expand' }));
    await flush();
    expect(liveFor('f00.ts\n')).toBeDefined();
    expect(live().length).toBeLessThanOrEqual(20);
  });
});

describe('DiffTab: панель (тест 3)', () => {
  it('переключатель колонок зовёт patchUi({ diffView }) и меняет renderSideBySide живых редакторов', async () => {
    bridge.setHandler('worktrees.diff', () => diff([file('a.ts'), file('b.ts')]));
    serve(WT, 'a.ts');
    serve(WT, 'b.ts');
    const patchUi = vi.spyOn(useUiStore.getState(), 'patchUi');
    renderTab();
    await flush();
    intersect(['a.ts', 'b.ts']);
    await flush();
    expect(live()).toHaveLength(2);
    for (const editor of live()) {
      expect(editor.options).toMatchObject({
        renderSideBySide: true,
        readOnly: true,
        hideUnchangedRegions: { enabled: true, contextLineCount: 3 },
      });
    }
    fireEvent.click(screen.getByRole('radio', { name: 'Inline' }));
    await flush();
    expect(patchUi).toHaveBeenCalledWith({ diffView: 'inline' });
    for (const editor of live()) expect(editor.options['renderSideBySide']).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Wrap lines' }));
    await flush();
    for (const editor of live()) expect(editor.options['wordWrap']).toBe('on');

    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    await flush();
    expect(live()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    await flush();
    expect(live()).toHaveLength(2);
  });

  it('«Collapse» секции убирает её редактор; «Expand» возвращает', async () => {
    bridge.setHandler('worktrees.diff', () => diff([file('a.ts')]));
    serve(WT, 'a.ts');
    renderTab();
    await flush();
    intersect(['a.ts']);
    await flush();
    expect(live()).toHaveLength(1);
    fireEvent.click(within(section('a.ts')).getByRole('button', { name: 'Collapse' }));
    await flush();
    expect(live()).toHaveLength(0);
    fireEvent.click(within(section('a.ts')).getByRole('button', { name: 'Expand' }));
    await flush();
    expect(live()).toHaveLength(1);
  });

  it('список и дерево файлов; клик по файлу прокручивает к секции', async () => {
    bridge.setHandler('worktrees.diff', () => diff([file('src/a.ts'), file('src/deep/b.ts'), file('top.md')]));
    renderTab();
    await flush();
    const list = screen.getByTestId('diff-file-list');
    expect(within(list).getByTitle('src/deep/b.ts').textContent).toContain('src/deep/b.ts');
    fireEvent.click(screen.getByRole('radio', { name: 'Tree' }));
    const tree = screen.getByTestId('diff-file-list');
    expect(within(tree).getByText('deep')).toBeTruthy();
    fireEvent.click(within(tree).getByTitle('src/deep/b.ts'));
    await flush();
    expect(scrolled).toContain(section('src/deep/b.ts'));
  });
});

describe('DiffTab: режим коммита (тест 6)', () => {
  it('файлы — из gitCommitFiles, а не из worktrees.diff; стороны hash^ и hash; заголовок с hash', async () => {
    bridge.setCommitFiles(WT, HASH, [file('a.ts')]);
    bridge.setGitShow(WT, `${HASH}^`, 'a.ts', text('before\n'));
    bridge.setGitShow(WT, HASH, 'a.ts', text('after\n'));
    const tab = diffTab('s-02', HASH);
    renderTab(work(), tab);
    await flush();
    expect(bridge.gitCommitFilesCalls).toEqual([{ root: WT, hash: HASH }]);
    expect(count('worktrees.diff')).toBe(0);
    intersect(['a.ts']);
    await flush();
    expect(live()[0]?.original.text).toBe('before\n');
    expect(live()[0]?.modified.text).toBe('after\n');
    expect(bridge.readTextCalls).toEqual([]);
    expect(tabMeta(tab, work()).title).toBe('Changes S02 · bbbbbbb');
  });

  it('отказ gitCommitFiles — текст по коду в теле', async () => {
    bridge.setCommitFiles(WT, HASH, { code: 'not_found', message: 'коммит не найден' });
    renderTab(work(), diffTab('s-02', HASH));
    await flush();
    expect(screen.getByText("Couldn't load diff: not found.")).toBeTruthy();
    expect(document.body.textContent).not.toContain('коммит');
  });
});

describe('DiffTab: обновление (тест 7)', () => {
  it('works.changed → новый worktrees.diff через дроссель; живой редактор перечитал сторону, прокрутка прежняя; ушедший файл — без секции', async () => {
    bridge.setHandler('worktrees.diff', () => diff([file('a.ts'), file('b.ts')]));
    bridge.setGitShow(WT, BASE, 'a.ts', text('base\n'));
    bridge.setFile(WT, 'a.ts', text('v1\n'));
    serve(WT, 'b.ts');
    renderTab();
    await flush();
    intersect(['a.ts']);
    await flush();
    const editor = liveFor('v1\n');
    expect(editor).toBeDefined();
    if (editor === undefined) return;
    editor.modified.scrollTop = 120;
    editor.original.scrollTop = 80;
    const reads = bridge.readTextCalls.filter((call) => call.path === 'a.ts').length;

    bridge.setFile(WT, 'a.ts', text('v2\n'));
    act(() => bridge.emit('works.changed', { entries: [work('renamed')], branches: {} }));
    await flush(500);
    expect(count('worktrees.diff')).toBe(1);
    await flush(2000);
    expect(count('worktrees.diff')).toBe(2);
    expect(bridge.readTextCalls.filter((call) => call.path === 'a.ts').length).toBe(reads + 1);
    // Тот же редактор, не перемонтирован: текст новый, прокрутка прежняя.
    expect(editor.disposed).toBe(false);
    expect(editor.modified.text).toBe('v2\n');
    expect(editor.modified.scrollTop).toBe(120);
    expect(editor.original.scrollTop).toBe(80);

    bridge.setHandler('worktrees.diff', () => diff([file('b.ts')]));
    act(() => bridge.emit('works.changed', { entries: [work('renamed again')], branches: {} }));
    await flush(2500);
    expect(document.querySelector('[data-diff-path="a.ts"]')).toBeNull();
    expect(editor.disposed).toBe(true);
    expect(section('b.ts')).toBeTruthy();
  });

  it('режим коммита не обновляется', async () => {
    bridge.setCommitFiles(WT, HASH, [file('a.ts')]);
    renderTab(work(), diffTab('s-02', HASH));
    await flush();
    act(() => bridge.emit('works.changed', { entries: [work('renamed')], branches: {} }));
    await flush(3000);
    expect(bridge.gitCommitFilesCalls).toHaveLength(1);
    expect(count('worktrees.diff')).toBe(0);
  });
});

describe('DiffTab: переход к файлу (тест 8)', () => {
  it('revealFile → секция смонтирована и прокручена; повтор с тем же путём — снова', async () => {
    bridge.setHandler('worktrees.diff', () => diff([file('src/a.ts'), file('src/b.ts')]));
    serve(WT, 'src/a.ts');
    serve(WT, 'src/b.ts');
    renderTab();
    await flush();
    act(() => useReviewStore.getState().revealFile(KEY, 'diff:s-02', 'src/b.ts'));
    await flush();
    expect(liveFor('src/b.ts\n')).toBeDefined();
    expect(scrolled.filter((element) => element === section('src/b.ts'))).toHaveLength(1);
    act(() => useReviewStore.getState().revealFile(KEY, 'diff:s-02', 'src/b.ts'));
    await flush();
    expect(scrolled.filter((element) => element === section('src/b.ts'))).toHaveLength(2);
  });

  it('переход записан до загрузки списка — срабатывает, когда файл пришёл; чужая вкладка не трогается', async () => {
    bridge.setHandler('worktrees.diff', () => diff([file('src/b.ts')]));
    serve(WT, 'src/b.ts');
    useReviewStore.getState().revealFile(KEY, 'diff:s-02:other', 'src/b.ts');
    useReviewStore.getState().revealFile(KEY, 'diff:s-02', 'src/b.ts');
    renderTab();
    await flush();
    await flush();
    expect(scrolled).toEqual([section('src/b.ts')]);
  });
});

describe('DiffTab: старый хост (тест 9)', () => {
  it('без worktrees.mergeCheck — «Host is outdated — restart», ни одного вызова', async () => {
    bridge.setHostMethods(REQUIRED_METHODS.filter((method) => method !== 'worktrees.mergeCheck'));
    renderTab();
    await flush();
    expect(screen.getByRole('button', { name: 'Host is outdated — restart' })).toBeTruthy();
    expect(count('worktrees.diff')).toBe(0);
    cleanup();
    renderTab(work(), diffTab('s-02', HASH));
    await flush();
    expect(bridge.gitCommitFilesCalls).toHaveLength(0);
  });
});

describe('DiffTab: сбой Monaco (тест 10)', () => {
  it('rejectInit → Editor didn’t load и Retry; Retry — вкладка собирается заново', async () => {
    bridge.setHandler('worktrees.diff', () => diff([file('a.ts')]));
    serve(WT, 'a.ts');
    monacoMock.rejectInit(new Error('chunk failed'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    renderTab();
    await flush();
    expect(screen.getByText("Editor didn't load")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await flush();
    expect(screen.queryByText("Editor didn't load")).toBeNull();
    intersect(['a.ts']);
    await flush();
    expect(live()).toHaveLength(1);
  });
});

describe('DiffTab: сессия без worktree (тест 11)', () => {
  it('файлы changes.project; стороны — gitShow(HEAD) и readText корня проекта; заглушки «нет worktree» нет', async () => {
    bridge.setHandler('changes.project', () => ({ patch: '', files: [file('x.ts')], stats: { additions: 1, deletions: 1 }, branch: 'master' }));
    serve(PROJECT, 'x.ts', 'HEAD');
    renderTab(work(), diffTab('s-04'));
    await flush();
    expect(count('changes.project')).toBe(1);
    expect(count('worktrees.diff')).toBe(0);
    intersect(['x.ts']);
    await flush();
    expect(bridge.gitShowCalls).toEqual([{ root: PROJECT, rev: 'HEAD', path: 'x.ts' }]);
    expect(bridge.readTextCalls).toEqual([{ root: PROJECT, path: 'x.ts' }]);
    expect(live()[0]?.original.text).toBe('old x.ts\n');
    expect(document.body.textContent).not.toContain('This session has no worktree of its own');
  });

  it('worktree ещё не создан — текст pending, вызовов нет', async () => {
    renderTab(work('w-a', [makeSession('s-02', 'two', { worktree: { ...WORKTREE, createdAt: null } })]));
    await flush();
    expect(screen.getByText('The worktree will be created when the session starts')).toBeTruthy();
    expect(count('worktrees.diff')).toBe(0);
  });
});
