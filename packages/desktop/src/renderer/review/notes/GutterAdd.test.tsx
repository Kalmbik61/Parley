/**
 * Кусок 8.4b, тест 1: «+» гаттера — свой оверлей над номерами строк. Строка под указателем — по
 * `getTopForLineNumber` поддельного редактора ((n − 1) × 20); протяжка — диапазон строк; ⌘⇧A —
 * заметка на выделение (действие редактора, `press`).
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
    const strip = screen.getByTestId('gutter-add');

    fireEvent.pointerMove(strip, { clientY: y(7) });
    const plus = screen.getByRole('button', { name: 'Add note' });
    expect(plus.style.top).toBe('120px');

    fireEvent.pointerDown(strip, { clientY: y(10), button: 0 });
    fireEvent.pointerMove(strip, { clientY: y(12) });
    fireEvent.pointerMove(strip, { clientY: y(14) });
    fireEvent.pointerUp(strip, { clientY: y(14) });
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith(10, 14);
  });

  it('протяжка вверх — тот же диапазон по возрастанию; щелчок без протяжки — одна строка', () => {
    const diff = mountDiff();
    const onPick = vi.fn();
    render(<GutterAdd editor={diff.modified as never} lineCount={30} onPick={onPick} />);
    const strip = screen.getByTestId('gutter-add');
    fireEvent.pointerDown(strip, { clientY: y(14), button: 0 });
    fireEvent.pointerMove(strip, { clientY: y(10) });
    fireEvent.pointerUp(strip, { clientY: y(10) });
    expect(onPick).toHaveBeenLastCalledWith(10, 14);

    fireEvent.pointerDown(strip, { clientY: y(3), button: 0 });
    fireEvent.pointerUp(strip, { clientY: y(3) });
    expect(onPick).toHaveBeenLastCalledWith(3, 3);
  });

  it('за последней строкой «+» нет и протяжка ничего не ставит', () => {
    const diff = mountDiff();
    const onPick = vi.fn();
    render(<GutterAdd editor={diff.modified as never} lineCount={30} onPick={onPick} />);
    const strip = screen.getByTestId('gutter-add');
    fireEvent.pointerMove(strip, { clientY: y(40) });
    expect(screen.queryByRole('button', { name: 'Add note' })).toBeNull();
    fireEvent.pointerDown(strip, { clientY: y(40), button: 0 });
    fireEvent.pointerUp(strip, { clientY: y(40) });
    expect(onPick).not.toHaveBeenCalled();
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
