// packages/desktop/src/renderer/browser/annotate/AnnotationTray.test.tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { AnnotationItem } from './store.js';
import { AnnotationTray } from './AnnotationTray.js';

afterEach(() => cleanup());

const VIEWPORT = { width: 1280, height: 800, dpr: 2 };
const PAGE = 'http://localhost:5173/';
// Без пробела в конце: getByTitle сравнивает подпись после обрезки пробелов.
const LONG = 'very long comment '.repeat(20).trim();

const ITEMS: AnnotationItem[] = [
  {
    n: 1,
    key: 'a1',
    generation: 0,
    url: PAGE,
    comment: LONG,
    gone: false,
    rect: null,
    target: { kind: 'element', key: 'a1', selector: 'main > button.save', text: 'Save', html: '<button>', styles: {}, anchor: { fx: 0, fy: 0 }, viewport: VIEWPORT },
  },
  {
    n: 2,
    key: 'a2',
    generation: 0,
    url: PAGE,
    comment: '',
    gone: true,
    rect: null,
    target: { kind: 'region', key: 'a2', rect: { x: 0, y: 0, width: 308.4, height: 19.6 }, elements: [], anchor: { fx: 0, fy: 0 }, viewport: VIEWPORT },
  },
];

function handlers() {
  return { onToggle: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn(), onClear: vi.fn(), onAddToChat: vi.fn() };
}

describe('AnnotationTray (спека браузера 4.7; каркас — по Orca)', () => {
  it('шапка — число; пункт — номер, цель, комментарий в одну строку, «element gone»; правка и удаление по номеру', () => {
    const h = handlers();
    render(<AnnotationTray items={ITEMS} collapsed={false} busy={false} {...h} />);
    const tray = screen.getByTestId('annotation-tray');
    expect(within(tray).getByRole('button', { name: /2 annotations/ })).toBeTruthy();
    const [first, second] = within(tray).getAllByRole('listitem') as [HTMLElement, HTMLElement];
    expect(first.textContent).toContain('button.save');
    const comment = within(first).getByTitle(LONG);
    expect(comment.className).toContain('truncate');
    expect(second.textContent).toContain('Region 308 × 20');
    expect(second.textContent).toContain('No comment');
    expect(second.textContent).toContain('element gone');
    fireEvent.click(within(tray).getByRole('button', { name: 'Edit annotation 1' }));
    fireEvent.click(within(tray).getByRole('button', { name: 'Delete annotation 2' }));
    expect(h.onEdit).toHaveBeenCalledWith(1);
    expect(h.onDelete).toHaveBeenCalledWith(2);
  });

  it('Фокус ревью 6: у Orca в лотке «Send» с отправкой и «Copy» в буфер — здесь их нет, ничего не уходит само', () => {
    render(<AnnotationTray items={ITEMS} collapsed={false} busy={false} {...handlers()} />);
    expect(screen.queryByRole('button', { name: /send|copy/i })).toBeNull();
  });

  it('свёрнут — только шапка «N annotations»; клик по ней — onToggle', () => {
    const h = handlers();
    render(<AnnotationTray items={ITEMS} collapsed busy={false} {...h} />);
    expect(screen.queryAllByRole('listitem')).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: /2 annotations/ }));
    expect(h.onToggle).toHaveBeenCalledTimes(1);
  });

  it('Clear и Add to chat; пока идёт добавление — неактивны', () => {
    const h = handlers();
    const view = render(<AnnotationTray items={ITEMS} collapsed={false} busy={false} {...h} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to chat' }));
    expect([h.onClear.mock.calls.length, h.onAddToChat.mock.calls.length]).toEqual([1, 1]);
    view.rerender(<AnnotationTray items={ITEMS} collapsed={false} busy {...h} />);
    expect((screen.getByRole('button', { name: 'Add to chat' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Clear' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('пункты разных документов с одним ключом — две строки без предупреждения React о повторе ключа', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const [first] = ITEMS as [AnnotationItem, AnnotationItem];
    // Скрипт нового документа нумерует с a1 заново: ключ тот же, поколение другое.
    const again: AnnotationItem = { ...first, n: 2, generation: 1 };
    render(<AnnotationTray items={[first, again]} collapsed={false} busy={false} {...handlers()} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
