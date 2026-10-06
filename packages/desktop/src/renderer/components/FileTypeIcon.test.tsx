/**
 * Значок файла или папки (спека значков 2026-10-06, раздел 5): адрес — из `@parley/file-icons`, тема —
 * из `useUiStore` и переключается на лету, как у `AgentIcon`; картинка декоративная и не перетаскивается.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useUiStore } from '../store/ui.js';
import { FileTypeIcon } from './FileTypeIcon.js';

beforeEach(() => useUiStore.setState({ dark: true }));
afterEach(cleanup);

const imageOf = (container: HTMLElement): HTMLImageElement | null => container.querySelector('img[data-file-icon]');

describe('FileTypeIcon', () => {
  it('файл — значок по имени, адрес относительный от index.html', () => {
    const { container } = render(<FileTypeIcon path="src/package.json" />);
    expect(imageOf(container)?.getAttribute('src')).toBe('file-icons/nodejs.svg');
  });

  it('папка — закрытая и открытая', () => {
    const closed = render(<FileTypeIcon path="src" kind="folder" />);
    expect(imageOf(closed.container)?.getAttribute('src')).toBe('file-icons/folder-src.svg');
    closed.unmount();
    const open = render(<FileTypeIcon path="src" kind="folder" open />);
    expect(imageOf(open.container)?.getAttribute('src')).toBe('file-icons/folder-src-open.svg');
  });

  it('тема переключается на лету: в светлой — вариант _light', () => {
    const { container } = render(<FileTypeIcon path="config.toml" />);
    expect(imageOf(container)?.getAttribute('src')).toBe('file-icons/toml.svg');
    act(() => useUiStore.setState({ dark: false }));
    expect(imageOf(container)?.getAttribute('src')).toBe('file-icons/toml_light.svg');
  });

  it('декоративный квадрат: alt пустой, не перетаскивается, 16 по умолчанию, size меняет сторону', () => {
    const small = render(<FileTypeIcon path="a.ts" />);
    const image = imageOf(small.container);
    expect(image?.getAttribute('alt')).toBe('');
    expect(image?.getAttribute('draggable')).toBe('false');
    expect(image?.getAttribute('width')).toBe('16');
    expect(image?.getAttribute('height')).toBe('16');
    small.unmount();
    const tab = render(<FileTypeIcon path="a.ts" size={14} />);
    expect(imageOf(tab.container)?.getAttribute('width')).toBe('14');
  });

  it('fileKind — метка data-file-kind; без него метки нет', () => {
    const marked = render(<FileTypeIcon path="x.md" fileKind="markdown" />);
    expect(imageOf(marked.container)?.getAttribute('data-file-kind')).toBe('markdown');
    marked.unmount();
    const plain = render(<FileTypeIcon path="x.md" />);
    expect(imageOf(plain.container)?.hasAttribute('data-file-kind')).toBe(false);
  });
});
