// packages/desktop/src/renderer/browser/annotate/AnnotationEditor.test.tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AnnotationEditor } from './AnnotationEditor.js';

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

function props(patch: Partial<Parameters<typeof AnnotationEditor>[0]> = {}): Parameters<typeof AnnotationEditor>[0] {
  return { n: 2, draft: 'hi', anchor: { left: 120, top: 40 }, container: null, onDraft: vi.fn(), onSave: vi.fn(), onDelete: vi.fn(), onCancel: vi.fn(), ...patch };
}

describe('AnnotationEditor (спека браузера 4.7; поповер — по Orca)', () => {
  it('поле в фокусе, до 2000 символов; Enter — Save, ⇧Enter — нет; Delete; якорь — в переданной точке, поповер — в слое страницы', () => {
    const layer = document.createElement('div');
    document.body.append(layer);
    const p = props({ container: layer });
    render(<AnnotationEditor {...p} />);
    const field = screen.getByRole('textbox', { name: 'Comment for annotation 2' });
    expect(document.activeElement).toBe(field);
    expect(field.getAttribute('maxlength')).toBe('2000');
    fireEvent.change(field, { target: { value: 'make it green' } });
    expect(p.onDraft).toHaveBeenCalledWith('make it green');
    fireEvent.keyDown(field, { key: 'Enter', shiftKey: true });
    expect(p.onSave).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(p.onSave).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(p.onDelete).toHaveBeenCalledTimes(1);
    expect(layer.contains(screen.getByTestId('annotation-editor'))).toBe(true);
    const anchor = screen.getByTestId('annotation-anchor');
    expect([anchor.style.left, anchor.style.top]).toEqual(['120px', '40px']);
  });

  it('Esc — отмена, до вкладки он не доходит (там Esc выключил бы режим)', () => {
    const onKeyDown = vi.fn();
    const p = props();
    render(
      <div onKeyDown={onKeyDown}>
        <AnnotationEditor {...p} />
      </div>,
    );
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    expect(p.onCancel).toHaveBeenCalledTimes(1);
    expect(onKeyDown).not.toHaveBeenCalled();
  });

  it('клик мимо (в том числе в страницу) редактор не закрывает: текст человека не теряется', async () => {
    const p = props();
    render(<AnnotationEditor {...p} />);
    // Radix слушает «клик мимо» со следующего такта после открытия.
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Фокус уходит из поля в страницу (она вне дерева React): пока поле «в фокусе», Radix «фокус вне» не видит.
    fireEvent.blur(screen.getByRole('textbox'));
    fireEvent.pointerDown(document.body);
    fireEvent.focusIn(document.body);
    // «Клик мимо» Radix откладывает до самого click: один pointerDown закрытия не просит, и тест без click был бы пустым.
    fireEvent.click(document.body);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(p.onCancel).not.toHaveBeenCalled();
    expect(screen.getByTestId('annotation-editor')).toBeTruthy();
  });

  it('кнопка Save сохраняет; Enter во время набора иероглифов (IME) подтверждает слово, а не сохраняет', () => {
    const p = props();
    render(<AnnotationEditor {...p} />);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', isComposing: true });
    expect(p.onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(p.onSave).toHaveBeenCalledTimes(1);
  });
});
