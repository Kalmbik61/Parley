/**
 * Кусок 7.5, тесты 2 и 3: ссылки превью Markdown и само превью — без сырого HTML, картинки только
 * через `files.readBytes`, http(s) — вкладка встроенного браузера (fix-7.5), относительная ссылка —
 * вкладка файла.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileRoot } from '../../../shared/files-types.js';
import { useLayoutStore } from '../../layout/store.js';
import type { TabSpec } from '../../../shared/layout-types.js';
import { createFakeBridge, type FakeBridge } from '../../test-utils/fake-bridge.js';
import { MarkdownPreview, resolveMarkdownLink, safeUrlTransform } from './MarkdownPreview.js';

const ROOT: FileRoot = { workKey: '/tmp/proj w-01', spec: { kind: 'project' } };

/** Активная работа с пустой группой — куда `openInBrowserTab` кладёт вкладку браузера. */
function activeWork(): void {
  useLayoutStore.setState({
    activeWorkKey: ROOT.workKey,
    layouts: { [ROOT.workKey]: { root: { type: 'group', id: 'g1', tabs: [], activeTabId: null }, activeGroupId: 'g1', closedTabs: [] } },
    hydrated: { [ROOT.workKey]: true },
  });
}

function workTabs(): TabSpec[] {
  const layout = useLayoutStore.getState().layouts[ROOT.workKey];
  return layout?.root.type === 'group' ? layout.root.tabs : [];
}

describe('safeUrlTransform (fix-7.5)', () => {
  it('http(s), относительные пути и #якоря — как есть', () => {
    expect(safeUrlTransform('https://example.com/a?b=1#c')).toBe('https://example.com/a?b=1#c');
    expect(safeUrlTransform('HTTP://example.com')).toBe('HTTP://example.com');
    expect(safeUrlTransform('./img/a.png')).toBe('./img/a.png');
    expect(safeUrlTransform('../README.md#usage')).toBe('../README.md#usage');
    expect(safeUrlTransform('/src/a.ts')).toBe('/src/a.ts');
    expect(safeUrlTransform('notes/a:b.md')).toBe('notes/a:b.md');
    expect(safeUrlTransform('my%20notes.md?raw=1')).toBe('my%20notes.md?raw=1');
    expect(safeUrlTransform('#section')).toBe('#section');
  });

  it('javascript:, data:, file:, vbscript:, mailto: и прочие схемы — пустая строка', () => {
    for (const url of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      ' javascript:alert(1)',
      'java\tscript:alert(1)',
      '\u0001javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'data:image/png;base64,AAAA',
      'file:///etc/passwd',
      'vbscript:msgbox(1)',
      'mailto:a@b.c',
      'blob:https://example.com/x',
    ]) {
      expect(safeUrlTransform(url), url).toBe('');
    }
  });

  it('адрес без схемы на другой хост (//хост, \\\\хост) — пустая строка', () => {
    expect(safeUrlTransform('//evil.example/x')).toBe('');
    expect(safeUrlTransform('\\\\evil.example/x')).toBe('');
    expect(safeUrlTransform('/\\evil.example/x')).toBe('');
  });
});

describe('resolveMarkdownLink (тест 2)', () => {
  it('https — external; ./img/a.png от docs/x.md — docs/img/a.png; #section — anchor; javascript: — null', () => {
    expect(resolveMarkdownLink('https://example.com/a?b=1', 'docs/x.md')).toEqual({ kind: 'external', url: 'https://example.com/a?b=1' });
    expect(resolveMarkdownLink('./img/a.png', 'docs/x.md')).toEqual({ kind: 'file', path: 'docs/img/a.png' });
    expect(resolveMarkdownLink('#section', 'docs/x.md')).toEqual({ kind: 'anchor', id: 'section' });
    expect(resolveMarkdownLink('javascript:alert(1)', 'docs/x.md')).toBeNull();
  });

  it('http — external; file:, data:, mailto: и //хост — null; выход выше корня — null', () => {
    expect(resolveMarkdownLink('http://example.com', 'x.md')).toEqual({ kind: 'external', url: 'http://example.com' });
    expect(resolveMarkdownLink('file:///etc/passwd', 'x.md')).toBeNull();
    expect(resolveMarkdownLink('data:text/html,x', 'x.md')).toBeNull();
    expect(resolveMarkdownLink('mailto:a@b.c', 'x.md')).toBeNull();
    expect(resolveMarkdownLink('//evil.example/x', 'x.md')).toBeNull();
    expect(resolveMarkdownLink('../../etc/passwd', 'docs/x.md')).toBeNull();
    expect(resolveMarkdownLink('', 'x.md')).toBeNull();
  });

  it('../, пробелы %20 и кириллица, хвост #якорь и ?запрос отбрасываются; /путь — от корня', () => {
    expect(resolveMarkdownLink('../README.md#usage', 'docs/x.md')).toEqual({ kind: 'file', path: 'README.md' });
    expect(resolveMarkdownLink('my%20notes.md', 'docs/x.md')).toEqual({ kind: 'file', path: 'docs/my notes.md' });
    expect(resolveMarkdownLink('заметки.md?raw=1', 'x.md')).toEqual({ kind: 'file', path: 'заметки.md' });
    expect(resolveMarkdownLink('/src/a.ts', 'docs/x.md')).toEqual({ kind: 'file', path: 'src/a.ts' });
    expect(resolveMarkdownLink('#%D0%B0', 'x.md')).toEqual({ kind: 'anchor', id: 'а' });
  });
});

describe('MarkdownPreview (тест 3)', () => {
  let bridge: FakeBridge;
  let onOpenFile: ReturnType<typeof vi.fn>;
  const created: Blob[] = [];
  const revoked: string[] = [];

  beforeEach(() => {
    bridge = createFakeBridge();
    onOpenFile = vi.fn();
    created.length = 0;
    revoked.length = 0;
    // В jsdom нет `URL.createObjectURL`: подставной ведёт журнал.
    URL.createObjectURL = vi.fn((blob: Blob) => {
      created.push(blob);
      return `blob:parley/${created.length}`;
    });
    URL.revokeObjectURL = vi.fn((url: string) => void revoked.push(url));
  });

  afterEach(() => cleanup());

  function renderPreview(text: string, filePath = 'docs/x.md'): ReturnType<typeof render> {
    return render(<MarkdownPreview bridge={bridge} root={ROOT} filePath={filePath} text={text} onOpenFile={onOpenFile} />);
  }

  it('<script> в тексте показан текстом, а не исполняется; разметка GFM работает', () => {
    const { container } = renderPreview('# Title\n\n<script>alert(1)</script>\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<img src=x onerror=alert(1)>');
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
    expect(screen.getByRole('heading', { name: 'Title' })).toBeTruthy();
    expect(container.querySelector('table')).not.toBeNull();
  });

  it('картинка с относительным путём грузится через files.readBytes в Blob; revokeObjectURL при размонтировании', async () => {
    bridge.setBytes(ROOT, 'docs/img/a.png', new Uint8Array([137, 80, 78, 71]));
    const { container, unmount } = renderPreview('![logo](./img/a.png)');
    await waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:parley/1'));
    expect(bridge.readBytesCalls).toEqual([{ root: ROOT, path: 'docs/img/a.png' }]);
    expect(created[0]?.type).toBe('image/png');
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('logo');
    unmount();
    expect(revoked).toEqual(['blob:parley/1']);
  });

  it('картинка по http(s) и file:// не грузится: вместо неё — alt текстом, ни readBytes, ни src', () => {
    const { container } = renderPreview('![remote](https://example.com/a.png) ![local](file:///etc/a.png)');
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('remote');
    expect(bridge.readBytesCalls).toEqual([]);
  });

  it('ссылка https — вкладка встроенного браузера той же работы; относительная — вкладка файла; javascript: и file: — ничего', () => {
    activeWork();
    renderPreview('[site](https://example.com) [other](../README.md) [bad](javascript:alert(1)) [local](file:///etc/passwd)');
    fireEvent.click(screen.getByText('site'));
    expect(workTabs()).toMatchObject([{ kind: 'browser', url: 'https://example.com' }]);
    fireEvent.click(screen.getByText('other'));
    expect(onOpenFile).toHaveBeenCalledWith('README.md');
    // Переход окна по ссылке погашен: клик не дошёл до браузерного действия.
    expect(fireEvent.click(screen.getByText('bad'))).toBe(false);
    expect(fireEvent.click(screen.getByText('local'))).toBe(false);
    expect(workTabs()).toHaveLength(1);
    expect(onOpenFile).toHaveBeenCalledTimes(1);
    // Системный браузер не зовётся: он — только пунктом меню у ссылок терминала.
    expect(bridge.externalOpened).toEqual([]);
  });

  it('#якорь прокручивает к заголовку с этим id', () => {
    const scrolled: string[] = [];
    HTMLElement.prototype.scrollIntoView = function scrollIntoView(this: HTMLElement) {
      scrolled.push(this.id);
    };
    renderPreview('[go](#second-part)\n\n# First\n\n## Second part');
    fireEvent.click(screen.getByText('go'));
    expect(scrolled).toEqual(['second-part']);
  });
});
