import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { S } from '../../shared/strings.js';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { AttachmentChip } from './AttachmentChip.js';
import { resetThumbnailCacheForTests } from './use-thumbnail.js';

const PNG = 'data:image/png;base64,AAAA';

beforeEach(() => {
  resetThumbnailCacheForTests();
});

afterEach(() => {
  cleanup();
});

describe('AttachmentChip', () => {
  it('имя — последний сегмент пути: «/», «\\», хвостовой разделитель; полный путь — в title', () => {
    for (const [path, name] of [
      ['/a/b/c.txt', 'c.txt'],
      ['C:\\users\\me\\my notes.txt', 'my notes.txt'],
      ['/a/dir/', 'dir'],
      ['/', '/'],
    ] as const) {
      const view = render(<AttachmentChip path={path} bridge={null} size="feed" />);
      const chip = screen.getByTestId('chat-attachment');
      expect(chip.textContent, path).toBe(name);
      expect(chip.getAttribute('title'), path).toBe(path);
      view.unmount();
    }
  });

  it('значок: файл — FileText, картинка без миниатюры — ImageIcon; длинное имя режется многоточием (truncate) в пределах чипа', () => {
    const longName = `${'very-long-file-name-'.repeat(6)}.txt`;
    const view = render(<AttachmentChip path={`/a/${longName}`} bridge={null} size="composer" />);
    const chip = screen.getByTestId('chat-attachment');
    expect(chip.textContent).toBe(longName);
    expect(chip.className).toContain('max-w-[min(16rem,100%)]');
    expect(chip.querySelector('span.truncate')?.textContent).toBe(longName);
    const fileIcon = chip.querySelector('svg')?.getAttribute('class');
    view.unmount();

    render(<AttachmentChip path="/a/gone.png" bridge={null} size="composer" />);
    const imageIcon = screen.getByTestId('chat-attachment').querySelector('svg')?.getAttribute('class');
    expect(imageIcon).toContain('lucide-image');
    expect(fileIcon).toContain('lucide-file-text');
  });

  it('кнопка «убрать» — только с onRemove: подпись с именем, клик зовёт onRemove', () => {
    const view = render(<AttachmentChip path="/a/notes.txt" bridge={null} size="composer" />);
    expect(screen.queryByRole('button')).toBeNull();
    const onRemove = vi.fn();
    view.rerender(<AttachmentChip path="/a/notes.txt" bridge={null} size="composer" onRemove={onRemove} />);
    fireEvent.click(screen.getByRole('button', { name: S.chat.composer.removeAttachment('notes.txt') }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('миниатюра: рамка фиксированного размера — 56×56 в поле, 160×120 в ленте; крестик поверх неё', async () => {
    const bridge = createFakeBridge();
    bridge.setThumbnail('/h/shot.png', PNG);
    const onRemove = vi.fn();
    const view = render(<AttachmentChip path="/h/shot.png" bridge={bridge} size="composer" onRemove={onRemove} />);
    await act(async () => {});
    const frame = screen.getByTestId('chat-attachment');
    expect(frame.hasAttribute('data-thumbnail')).toBe(true);
    expect(frame.className).toContain('size-14');
    expect(screen.getByRole('img', { name: 'shot.png' }).className).toContain('object-cover');
    fireEvent.click(screen.getByRole('button', { name: S.chat.composer.removeAttachment('shot.png') }));
    expect(onRemove).toHaveBeenCalledTimes(1);

    view.rerender(<AttachmentChip path="/h/shot.png" bridge={bridge} size="feed" />);
    expect(screen.getByTestId('chat-attachment').className).toContain('h-[120px] w-[160px]');
    expect(screen.queryByRole('button')).toBeNull();
  });
});
