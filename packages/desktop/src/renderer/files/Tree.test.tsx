/**
 * Кусок 7.2, тесты 3 и 4: дерево «Файлов» — ленивое раскрытие через `files.list` с кэшем до
 * `treeChanged`, игнорируемые скрыты, симлинк без цели не открывается, порядок и буква git.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import type { DirEntry, FileRoot, GitStatusLetter } from '../../shared/files-types.js';
import { rootKey } from '../../shared/work-keys.js';
import { EMPTY_HISTORY } from '../layout/history.js';
import { useLayoutStore } from '../layout/store.js';
import { emptyLayout, groups } from '../layout/tree.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { useUiStore } from '../store/ui.js';
import { useFilesStore } from './store.js';
import { Tree } from './Tree.js';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

const KEY = '/tmp/proj w-01';
const ROOT: FileRoot = { workKey: KEY, spec: { kind: 'project' } };

function entry(name: string, patch: Partial<DirEntry> = {}): DirEntry {
  return { name, kind: 'file', size: 1, mtimeMs: 1, ignored: false, target: null, ...patch };
}

let bridge: FakeBridge;

beforeEach(() => {
  vi.mocked(toast).mockClear();
  bridge = createFakeBridge();
  useFilesStore.setState({ rootByWork: {}, expanded: {} });
  useLayoutStore.setState({
    activeWorkKey: KEY,
    layouts: { [KEY]: emptyLayout() },
    hydrated: { [KEY]: true },
    pending: {},
    history: EMPTY_HISTORY,
    mru: {},
    navigating: false,
  });
});

afterEach(cleanup);

function renderTree(props: { status?: Record<string, GitStatusLetter>; showIgnored?: boolean; reloadToken?: number } = {}) {
  const view = (next: typeof props) => (
    <Tree
      bridge={bridge}
      root={ROOT}
      rootDir="/tmp/proj"
      status={next.status ?? {}}
      showIgnored={next.showIgnored ?? false}
      reloadToken={next.reloadToken ?? 0}
      onRootGone={() => {}}
    />
  );
  const result = render(view(props));
  return { rerender: (next: typeof props) => result.rerender(view(next)) };
}

const names = (): string[] => [...document.querySelectorAll('[data-tree-path]')].map((row) => row.getAttribute('data-tree-path') ?? '');

describe('Tree (тест 3)', () => {
  it('раскрытие зовёт files.list один раз; повторное раскрытие — из кэша до treeChanged', async () => {
    bridge.setDir(ROOT, '', [entry('src', { kind: 'dir' }), entry('a.ts')]);
    bridge.setDir(ROOT, 'src', [entry('lib.ts')]);
    const list = vi.spyOn(bridge.files, 'list');
    renderTree();
    await screen.findByText('a.ts');
    expect(list.mock.calls.map((call) => call[1])).toEqual(['']);

    fireEvent.click(screen.getByText('src'));
    await screen.findByText('lib.ts');
    expect(list.mock.calls.map((call) => call[1])).toEqual(['', 'src']);

    fireEvent.click(screen.getByText('src'));
    expect(screen.queryByText('lib.ts')).toBeNull();
    fireEvent.click(screen.getByText('src'));
    await screen.findByText('lib.ts');
    expect(list).toHaveBeenCalledTimes(2);

    // Раскрытая папка из события перечитывается сразу.
    bridge.setDir(ROOT, 'src', [entry('lib.ts'), entry('new.ts')]);
    act(() => bridge.emitTreeChanged({ rootKey: rootKey(ROOT), dirs: ['src'] }));
    await screen.findByText('new.ts');
    expect(list).toHaveBeenCalledTimes(3);

    // Свёрнутая — при следующем раскрытии, а не из устаревшего кэша.
    fireEvent.click(screen.getByText('src'));
    act(() => bridge.emitTreeChanged({ rootKey: rootKey(ROOT), dirs: ['src'] }));
    act(() => bridge.emitTreeChanged({ rootKey: 'чужой корень', dirs: [''] }));
    expect(list).toHaveBeenCalledTimes(3);
    fireEvent.click(screen.getByText('src'));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(4));
  });

  // Раунд main-r2, п. 6: гонку реестра корней закрывает main (пересборка на промахе), и
  // files:denied из main — окончательный отказ; окно его не повторяет.
  it('files:denied — тост сразу, list без повторов', async () => {
    const list = vi.spyOn(bridge.files, 'list').mockRejectedValue({ code: 'files:denied', message: 'unknown root' });
    renderTree();
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Path is outside the workspace folders'));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('игнорируемые скрыты по умолчанию; с showIgnored — видны и приглушены', async () => {
    bridge.setDir(ROOT, '', [entry('a.ts'), entry('debug.log', { ignored: true })]);
    const view = renderTree();
    await screen.findByText('a.ts');
    expect(screen.queryByText('debug.log')).toBeNull();
    view.rerender({ showIgnored: true });
    const row = (await screen.findByText('debug.log')).closest('[data-tree-path]');
    expect(row?.className).toContain('opacity-50');
  });

  it('папки первыми, затем файлы, без учёта регистра; симлинк на папку — как папка', async () => {
    bridge.setDir(ROOT, '', [
      entry('b.ts'),
      entry('Zeta', { kind: 'dir' }),
      entry('A.md'),
      entry('alpha', { kind: 'dir' }),
      entry('docs', { kind: 'symlink', target: 'dir' }),
    ]);
    renderTree();
    await screen.findByText('b.ts');
    expect(names()).toEqual(['alpha', 'docs', 'Zeta', 'A.md', 'b.ts']);
  });

  it('симлинк без target приглушён и не открывается; симлинк на файл открывается вкладкой', async () => {
    bridge.setDir(ROOT, '', [entry('dangling', { kind: 'symlink', target: null }), entry('readme', { kind: 'symlink', target: 'file' })]);
    renderTree();
    const dangling = await screen.findByText('dangling');
    expect(dangling.closest('[data-tree-path]')?.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(dangling);
    expect(groups(useLayoutStore.getState().layouts[KEY]!)[0]?.tabs).toEqual([]);

    fireEvent.click(screen.getByText('readme'));
    expect(groups(useLayoutStore.getState().layouts[KEY]!)[0]?.tabs).toEqual([
      { kind: 'file', id: 'file:p:readme', root: { kind: 'project' }, path: 'readme' },
    ]);
  });

  it('длинное имя обрезается многоточием, полный путь — в title', async () => {
    const long = `${'x'.repeat(250)}.ts`;
    bridge.setDir(ROOT, '', [entry(long)]);
    renderTree();
    const name = await screen.findByText(long);
    expect(name.className).toContain('truncate');
    expect(name.closest('[data-tree-path]')?.getAttribute('title')).toBe(long);
  });

  it('тысячи файлов в папке — в DOM только видимые строки (виртуализация)', async () => {
    bridge.setDir(ROOT, '', Array.from({ length: 3000 }, (_, index) => entry(`f${String(index).padStart(4, '0')}.ts`)));
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.hasAttribute('data-tree-scroll') ? 600 : 0;
      },
    });
    try {
      renderTree();
      await screen.findByText('f0000.ts');
      const count = names().length;
      expect(count).toBeGreaterThan(0);
      expect(count).toBeLessThan(200);
    } finally {
      if (original !== undefined) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', original);
    }
  });
});

describe('Tree — git-статус (тест 4)', () => {
  it('буква M и цвет изменённого файла; без статуса — ни буквы, ни цвета', async () => {
    bridge.setDir(ROOT, '', [entry('a.ts'), entry('b.ts')]);
    renderTree({ status: { 'a.ts': 'M' } });
    const name = await screen.findByText('a.ts');
    const row = name.closest('[data-tree-path]');
    expect(row?.querySelector('[data-git-status]')?.textContent).toBe('M');
    expect(name.style.color).toBe('var(--git-decoration-modified)');
    const plain = screen.getByText('b.ts');
    expect(plain.closest('[data-tree-path]')?.querySelector('[data-git-status]')).toBeNull();
    expect(plain.style.color).toBe('');
  });
});

// Облик Organic (спека окна 2026-09-29, 1.8, правый сайдбар): строки файлов — пилюли 28px, hover text 6 %;
// вторичный текст строки на hover — основной цвет (наследство куска 1).
describe('Tree — облик Organic (1.8)', () => {
  it('строка — пилюля 28px с hover text 6 %; вторичный текст на hover — основной цвет', async () => {
    bridge.setDir(ROOT, '', [entry('a.ts')]);
    renderTree({ status: { 'a.ts': 'M' } });
    const row = (await screen.findByText('a.ts')).closest('[data-tree-path]') as HTMLElement;
    expect(row.style.height).toBe('28px');
    expect(row.className).toMatch(/\brounded-full\b/);
    expect(row.className).toContain('hover:bg-foreground/6');
    expect(row.className).toContain('hover:[--muted-foreground:var(--foreground)]');
    expect(row.className).not.toContain('hover:bg-accent');
    expect(row.querySelector('[data-git-status]')?.className).toContain('font-bold');
  });

  // Правки ревью куска 2: имя и буква added, untracked (accent-2-700) и renamed (neutral-700) на hover-заливке
  // text 6 % в светлой — 4.31 и 4.40:1. Цвет идёт токеном git, поэтому подмена `--muted-foreground` его не
  // трогает: на hover строка берёт ступень 800 тех же рамп (`styles/tokens.test.ts`).
  it('на hover цвета git added, untracked и renamed — ступень 800 своей рампы (иначе на заливке text 6 % ниже 4.5:1)', async () => {
    bridge.setDir(ROOT, '', [entry('a.ts')]);
    renderTree({ status: { 'a.ts': 'A' } });
    const row = (await screen.findByText('a.ts')).closest('[data-tree-path]') as HTMLElement;
    expect(row.className).toContain('hover:[--git-decoration-added:var(--color-accent-2-800)]');
    expect(row.className).toContain('hover:[--git-decoration-untracked:var(--color-accent-2-800)]');
    expect(row.className).toContain('hover:[--git-decoration-renamed:var(--color-neutral-800)]');
  });

  it('вложенная строка сохраняет отступ по глубине: 8 + 18 на уровень слева', async () => {
    bridge.setDir(ROOT, '', [entry('src', { kind: 'dir' })]);
    bridge.setDir(ROOT, 'src', [entry('lib.ts')]);
    renderTree();
    fireEvent.click(await screen.findByText('src'));
    const nested = (await screen.findByText('lib.ts')).closest('[data-tree-path]') as HTMLElement;
    expect(nested.style.paddingLeft).toBe('26px');
  });
});

describe('Tree — значки (спека значков 3.1)', () => {
  const rowOf = (name: string): Element | null | undefined => screen.getByText(name).closest('[data-tree-path]');
  const iconOf = (name: string): string | null | undefined => rowOf(name)?.querySelector('img[data-file-icon]')?.getAttribute('src');

  beforeEach(() => useUiStore.setState({ dark: true }));

  it('папка: шеврон и значок папки, у раскрытой — свой; файл: значок по имени', async () => {
    bridge.setDir(ROOT, '', [entry('src', { kind: 'dir' }), entry('package.json')]);
    bridge.setDir(ROOT, 'src', [entry('main.ts')]);
    renderTree();
    await screen.findByText('package.json');
    expect(iconOf('src')).toBe('file-icons/folder-src.svg');
    expect(iconOf('package.json')).toBe('file-icons/nodejs.svg');

    fireEvent.click(screen.getByText('src'));
    await screen.findByText('main.ts');
    expect(iconOf('src')).toBe('file-icons/folder-src-open.svg');
    expect(iconOf('main.ts')).toBe('file-icons/typescript.svg');
  });

  it('значки в одном столбике: у файла пустое место под шеврон, затем значок', async () => {
    bridge.setDir(ROOT, '', [entry('src', { kind: 'dir' }), entry('a.ts')]);
    renderTree();
    await screen.findByText('a.ts');
    const file = rowOf('a.ts');
    expect(file?.children[0]?.childElementCount).toBe(0);
    expect(file?.children[1]?.tagName).toBe('IMG');
    const folder = rowOf('src');
    expect(folder?.children[0]?.querySelector('svg')).not.toBeNull();
    expect(folder?.children[1]?.tagName).toBe('IMG');
  });

  it('симлинк на файл — Link2 вместо значка; симлинк на папку — значок папки по имени (фокус ревью 3)', async () => {
    bridge.setDir(ROOT, '', [entry('docs', { kind: 'symlink', target: 'dir' }), entry('readme', { kind: 'symlink', target: 'file' })]);
    renderTree();
    await screen.findByText('readme');
    const link = rowOf('readme');
    expect(link?.querySelector('img[data-file-icon]')).toBeNull();
    expect(link?.children[1]?.querySelector('svg')).not.toBeNull();
    expect(iconOf('docs')).toBe('file-icons/folder-docs.svg');
  });
});
