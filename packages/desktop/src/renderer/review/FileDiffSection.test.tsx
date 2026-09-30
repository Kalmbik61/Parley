/**
 * Кусок 8.3: секция файла вкладки диффа — заглушки большого и двоичного файла, «Show anyway»,
 * ошибка загрузки сторон по коду и длинный путь в `title`.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiffFile, FileRoot, TextFile } from '../../shared/files-types.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { monacoMock } from '../test-utils/monaco-mock.js';
import { FileDiffSection, placeholderHeight, type FileDiffSectionProps } from './FileDiffSection.js';

vi.mock('@monaco-editor/react', async () => (await import('../test-utils/monaco-mock.js')).monacoReactMock);
vi.mock('../files/editor/monaco-setup.js', async () => (await import('../test-utils/monaco-mock.js')).monacoSetupMock);

const ROOT: FileRoot = { workKey: '/tmp/proj w-a', spec: { kind: 'worktree', sessionId: 's-02' } };
const BASE = 'a'.repeat(40);

function text(value: string, extra: Partial<TextFile> = {}): TextFile {
  return { text: value, mtimeMs: 1, size: value.length, binary: false, utf8: true, readOnlyReason: null, ...extra };
}

let bridge: FakeBridge;

function props(file: DiffFile, extra: Partial<FileDiffSectionProps> = {}): FileDiffSectionProps {
  return {
    file,
    files: bridge.files,
    root: ROOT,
    mode: { kind: 'branch', base: BASE },
    version: 1,
    live: true,
    collapsed: false,
    onToggle: () => {},
    options: { readOnly: true },
    split: true,
    theme: 'harnas-light',
    language: undefined,
    register: () => {},
    notes: null,
    ...extra,
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const M = (path: string): DiffFile => ({ path, status: 'M', oldPath: null, additions: 3, deletions: 1 });

beforeEach(() => {
  monacoMock.reset();
  bridge = createFakeBridge();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('FileDiffSection', () => {
  it('заглушка оценочной высоты: 20px × (строк + 2), не больше 600px', () => {
    expect(placeholderHeight(0)).toBe(40);
    expect(placeholderHeight(10)).toBe(240);
    expect(placeholderHeight(28)).toBe(600);
    expect(placeholderHeight(29)).toBe(600);
    render(<FileDiffSection {...props(M('a.ts'), { live: false })} />);
    const placeholder = document.querySelector<HTMLElement>('[data-diff-placeholder]');
    expect(placeholder?.style.height).toBe('120px');
    expect(bridge.readTextCalls).toEqual([]);
  });

  it('больше 1 МБ — заглушка и «Show anyway»; по нажатию — редактор', async () => {
    bridge.setGitShow(ROOT, BASE, 'big.txt', text('old\n'));
    bridge.setFile(ROOT, 'big.txt', text('x'.repeat(1024 * 1024 + 1)));
    render(<FileDiffSection {...props(M('big.txt'))} />);
    await flush();
    expect(screen.getByText('File is larger than 1 MB')).toBeTruthy();
    expect(monacoMock.diffEditors).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Show anyway' }));
    expect(monacoMock.diffEditors).toHaveLength(1);
  });

  it('больше 20 МБ (отказ files:too-large) — заглушка без «Show anyway»', async () => {
    bridge.setGitShow(ROOT, BASE, 'huge.txt', text('old\n'));
    bridge.setFile(ROOT, 'huge.txt', { code: 'files:too-large', message: 'x' });
    render(<FileDiffSection {...props(M('huge.txt'))} />);
    await flush();
    expect(screen.getByText('File is larger than 1 MB')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show anyway' })).toBeNull();
  });

  it('двоичный — «Binary file», без «Show anyway» и без редактора', async () => {
    bridge.setGitShow(ROOT, BASE, 'img.png', text('\0', { binary: true }));
    bridge.setFile(ROOT, 'img.png', text('\0\0', { binary: true }));
    render(<FileDiffSection {...props(M('img.png'))} />);
    await flush();
    expect(screen.getByText('Binary file')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show anyway' })).toBeNull();
    expect(monacoMock.diffEditors).toHaveLength(0);
  });

  it('отказ стороны — текст по коду в секции, сообщения main в DOM нет', async () => {
    bridge.setFile(ROOT, 'lost.ts', { code: 'not_found', message: 'файл пропал' });
    render(<FileDiffSection {...props({ ...M('lost.ts'), status: 'A' })} />);
    await flush();
    expect(screen.getByText("Couldn't load diff: not found.")).toBeTruthy();
    expect(document.body.textContent).not.toContain('пропал');
  });

  // `--destructive` светлой темы — accent-800 (кнопка удаления не сливается с главной, решение контролёра
  // куска 2), а `−N` в спеке окна 2026-09-29, 1.8 — accent-700 в обеих темах: числа не на токене удаления.
  it('счётчики: +N — accent-2-700 (status-success-text), −N — accent-700, а не text-destructive', () => {
    render(<FileDiffSection {...props(M('a.ts'), { live: false })} />);
    expect(screen.getByText('+3').className).toContain('text-status-success-text');
    expect(screen.getByText('−1').className).toContain('text-accent-700');
    expect(screen.getByText('−1').className).not.toContain('text-destructive');
  });

  it('длинный путь переименования — обрезается, полный текст в title', async () => {
    const long = `${'very-long-folder-name/'.repeat(20)}file.ts`;
    render(<FileDiffSection {...props({ path: long, status: 'R', oldPath: 'old.ts', additions: null, deletions: null }, { live: false })} />);
    const title = screen.getByTitle(`old.ts → ${long}`);
    expect(title.className).toContain('truncate');
    expect(title.className).toContain('min-w-0');
  });
});
