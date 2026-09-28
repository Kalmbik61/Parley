/**
 * Кусок 8.4b, тест 1: «+» гаттера — свой оверлей над номерами строк. Строка под указателем — по
 * `getTopForLineNumber` поддельного редактора ((n − 1) × 20); протяжка — диапазон строк; ⌘⇧A —
 * заметка на выделение (действие редактора, `press`).
 *
 * Раунд fix-8.4b, п. 2: сам оверлей указатель не ловит (под ним — кнопки Monaco, «Show Unchanged
 * Region»): «+» ставит движение мыши над DOM редактора, ловит указатель только кнопка «+».
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KeyCode, KeyMod, monacoMock, monacoReactMock, type FakeDiffEditor } from '../../test-utils/monaco-mock.js';
import { GutterAdd } from './GutterAdd.js';

vi.mock('../../files/editor/monaco-setup.js', async () => (await import('../../test-utils/monaco-mock.js')).monacoSetupMock);

const DiffEditor = monacoReactMock['DiffEditor'] as (props: Record<string, unknown>) => JSX.Element;
const TEXT = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');

/** Поддельный diff-редактор: `GutterAdd` получает его сторону, как в `FileDiffSection`. */
function mountDiff(): FakeDiffEditor {
  render(<DiffEditor original={TEXT} modified={TEXT} options={{}} />);
  const diff = monacoMock.diffEditors.at(-1);
  if (diff === undefined) throw new Error('нет редактора');
  return diff;
}

/** Середина строки n по шагу поддельного редактора. */
const y = (line: number): number => (line - 1) * 20 + 10;

/** Наведение мыши на строку n: движение над DOM стороны редактора (номер строки — у левого края). */
function hover(diff: FakeDiffEditor, line: number, clientX = 10): void {
  const dom = (diff.modified as unknown as { getDomNode(): HTMLElement }).getDomNode();
  fireEvent.pointerMove(dom, { clientX, clientY: y(line) });
}

const plus = (): HTMLElement => screen.getByRole('button', { name: 'Add note' });

beforeEach(() => {
  monacoMock.reset();
});

afterEach(() => {
  cleanup();
});

describe('GutterAdd (тест 1 куска 8.4b)', () => {
  it('наведение показывает «+» у строки; протяжка со строки 10 до 14 — onPick(10, 14)', () => {
    const diff = mountDiff();
    const onPick = vi.fn();
    render(<GutterAdd editor={diff.modified as never} lineCount={30} onPick={onPick} />);

    hover(diff, 7);
    expect(plus().style.top).toBe('120px');

    hover(diff, 10);
    fireEvent.pointerDown(plus(), { clientY: y(10), button: 0 });
    fireEvent.pointerMove(plus(), { clientY: y(12) });
    fireEvent.pointerMove(plus(), { clientY: y(14) });
    fireEvent.pointerUp(plus(), { clientY: y(14) });
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith(10, 14);
  });

  it('протяжка вверх — тот же диапазон по возрастанию; щелчок без протяжки — одна строка', () => {
    const diff = mountDiff();
    const onPick = vi.fn();
    render(<GutterAdd editor={diff.modified as never} lineCount={30} onPick={onPick} />);
    hover(diff, 14);
    fireEvent.pointerDown(plus(), { clientY: y(14), button: 0 });
    fireEvent.pointerMove(plus(), { clientY: y(10) });
    fireEvent.pointerUp(plus(), { clientY: y(10) });
    expect(onPick).toHaveBeenLastCalledWith(10, 14);

    hover(diff, 3);
    fireEvent.pointerDown(plus(), { clientY: y(3), button: 0 });
    fireEvent.pointerUp(plus(), { clientY: y(3) });
    expect(onPick).toHaveBeenLastCalledWith(3, 3);
  });

  it('за последней строкой «+» нет', () => {
    const diff = mountDiff();
    const onPick = vi.fn();
    render(<GutterAdd editor={diff.modified as never} lineCount={30} onPick={onPick} />);
    hover(diff, 40);
    expect(screen.queryByRole('button', { name: 'Add note' })).toBeNull();
    expect(onPick).not.toHaveBeenCalled();
  });

  it('оверлей указатель не перехватывает (кнопки Monaco под ним живы); «+» — только над номерами строк и пропадает с уходом мыши (fix-8.4b, п. 2)', () => {
    const diff = mountDiff();
    render(<GutterAdd editor={diff.modified as never} lineCount={30} onPick={vi.fn()} />);
    const strip = screen.getByTestId('gutter-add');
    expect(strip.className).toContain('pointer-events-none');

    hover(diff, 5);
    expect(plus().className).toContain('pointer-events-auto');
    // Правее полосы номеров (текст строки) — «+» нет.
    hover(diff, 5, 200);
    expect(screen.queryByRole('button', { name: 'Add note' })).toBeNull();

    hover(diff, 5);
    const dom = (diff.modified as unknown as { getDomNode(): HTMLElement }).getDomNode();
    // Мышь ушла с редактора на саму кнопку «+» — она остаётся; ушла совсем — пропадает.
    fireEvent.pointerLeave(dom, { relatedTarget: plus() });
    expect(plus()).toBeTruthy();
    fireEvent.pointerLeave(plus(), { relatedTarget: document.body });
    expect(screen.queryByRole('button', { name: 'Add note' })).toBeNull();
  });

  it('⌘⇧A — заметка на выделение редактора; без выделения — ничего', () => {
    const diff = mountDiff();
    const onPick = vi.fn();
    const { unmount } = render(<GutterAdd editor={diff.modified as never} lineCount={30} onPick={onPick} />);
    const chord = KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyA;
    act(() => diff.modified.press(chord));
    expect(onPick).not.toHaveBeenCalled();

    diff.modified.selection = { startLineNumber: 5, endLineNumber: 8 };
    act(() => diff.modified.press(chord));
    expect(onPick).toHaveBeenCalledWith(5, 8);

    // Оверлей ушёл (режим коммита, секция свёрнута) — сочетание больше ничего не ставит.
    unmount();
    act(() => diff.modified.press(chord));
    expect(onPick).toHaveBeenCalledTimes(1);
  });
});
