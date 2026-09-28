/**
 * Кусок 7.5, тесты 2 и 3: ссылки превью Markdown и само превью — без сырого HTML, картинки только
 * через `files.readBytes`, http(s) — через `app.openExternal`, относительная ссылка — вкладка файла.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileRoot } from '../../../shared/files-types.js';
import { createFakeBridge, type FakeBridge } from '../../test-utils/fake-bridge.js';
import { MarkdownPreview, resolveMarkdownLink } from './MarkdownPreview.js';

const ROOT: FileRoot = { workKey: '/tmp/proj w-01', spec: { kind: 'project' } };

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
      return `blob:harnas/${created.length}`;
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
    await waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:harnas/1'));
    expect(bridge.readBytesCalls).toEqual([{ root: ROOT, path: 'docs/img/a.png' }]);
    expect(created[0]?.type).toBe('image/png');
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('logo');
    unmount();
    expect(revoked).toEqual(['blob:harnas/1']);
  });

  it('картинка по http(s) и file:// не грузится: вместо неё — alt текстом, ни readBytes, ни src', () => {
    const { container } = renderPreview('![remote](https://example.com/a.png) ![local](file:///etc/a.png)');
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('remote');
    expect(bridge.readBytesCalls).toEqual([]);
  });

  it('ссылка https — app.openExternal; относительная — вкладка файла; javascript: — ничего', () => {
    renderPreview('[site](https://example.com) [other](../README.md) [bad](javascript:alert(1))');
    fireEvent.click(screen.getByText('site'));
    expect(bridge.externalOpened).toEqual(['https://example.com']);
    fireEvent.click(screen.getByText('other'));
    expect(onOpenFile).toHaveBeenCalledWith('README.md');
    const bad = screen.getByText('bad');
    // Переход окна по ссылке погашен: клик не дошёл до браузерного действия.
    expect(fireEvent.click(bad)).toBe(false);
    expect(bridge.externalOpened).toEqual(['https://example.com']);
    expect(onOpenFile).toHaveBeenCalledTimes(1);
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
