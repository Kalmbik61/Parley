/**
 * Кусок 7.3b: обёртка Monaco с подставным модулем — опции спеки 10.4, команды ⌘S и ⌥Z, позиция
 * курсора, текст с диска без потери курсора, вид после перемонтирования, тема по `.dark`.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUiStore } from '../../store/ui.js';
import { KeyCode, KeyMod, monacoMock } from '../../test-utils/monaco-mock.js';
import { MonacoEditor, type MonacoEditorProps } from './MonacoEditor.js';

vi.mock('@monaco-editor/react', async () => (await import('../../test-utils/monaco-mock.js')).monacoReactMock);
vi.mock('./monaco-setup.js', async () => (await import('../../test-utils/monaco-mock.js')).monacoSetupMock);

beforeEach(() => {
  monacoMock.reset();
  useUiStore.setState({ dark: false });
});
afterEach(cleanup);

function props(patch: Partial<MonacoEditorProps> = {}): MonacoEditorProps {
  return {
    viewStateKey: 'k',
    modelPath: 'harnas://buffer/k/a.ts',
    text: 'a\n',
    readOnly: false,
    fontFamily: 'Menlo',
    fontSize: 13,
    reveal: null,
    onRevealed: vi.fn(),
    onChange: vi.fn(),
    onSave: vi.fn(),
    ...patch,
  };
}

async function mounted(): Promise<(typeof monacoMock.editors)[number]> {
  await waitFor(() => expect(monacoMock.editors.length).toBeGreaterThan(0));
  const last = monacoMock.editors.at(-1);
  if (last === undefined) throw new Error('нет редактора');
  return last;
}

describe('MonacoEditor', () => {
  it('опции спеки 10.4: шрифт терминала минус 1, без миникарты, перенос выключен', async () => {
    render(<MonacoEditor {...props()} />);
    expect((await mounted()).options).toMatchObject({
      fontFamily: 'Menlo',
      fontSize: 12,
      minimap: { enabled: false },
      renderWhitespace: 'selection',
      wordWrap: 'off',
      scrollBeyondLastLine: false,
      readOnly: false,
    });
  });

  it('⌘S — onSave; правка — onChange', async () => {
    const onSave = vi.fn();
    const onChange = vi.fn();
    render(<MonacoEditor {...props({ onSave, onChange })} />);
    const editor = await mounted();
    act(() => editor.press(KeyMod.CtrlCmd | KeyCode.KeyS));
    expect(onSave).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByTestId('monaco-textarea'), { target: { value: 'b' } });
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('reveal ставит курсор на строку и колонку и зовёт onRevealed', async () => {
    const onRevealed = vi.fn();
    render(<MonacoEditor {...props({ reveal: { line: 3, col: 7 }, onRevealed })} />);
    const editor = await mounted();
    await waitFor(() => expect(onRevealed).toHaveBeenCalled());
    expect(editor.position).toEqual({ lineNumber: 3, column: 7 });
  });

  it('reveal показывает саму колонку, а не начало строки: совпадение глубоко в длинной строке видно (раунд fix-7.4, п. 2)', async () => {
    render(<MonacoEditor {...props({ reveal: { line: 1, col: 2_881_005 } })} />);
    const editor = await mounted();
    await waitFor(() => expect(editor.revealed).toEqual({ lineNumber: 1, column: 2_881_005 }));
  });

  it('новый текст с диска — в модель, курсор прежний', async () => {
    const { rerender } = render(<MonacoEditor {...props({ reveal: { line: 2, col: 2 } })} />);
    const editor = await mounted();
    await waitFor(() => expect(editor.position).toEqual({ lineNumber: 2, column: 2 }));
    rerender(<MonacoEditor {...props({ text: 'x\ny\nz\n' })} />);
    await waitFor(() => expect(editor.getValue()).toBe('x\ny\nz\n'));
    expect(editor.position).toEqual({ lineNumber: 2, column: 2 });
  });

  it('курсор переживает перемонтирование той же вкладки', async () => {
    const first = render(<MonacoEditor {...props({ viewStateKey: 'keep', reveal: { line: 4, col: 1 } })} />);
    const editor = await mounted();
    await waitFor(() => expect(editor.position).toEqual({ lineNumber: 4, column: 1 }));
    first.unmount();
    render(<MonacoEditor {...props({ viewStateKey: 'keep' })} />);
    await waitFor(() => expect(monacoMock.editors).toHaveLength(2));
    expect(monacoMock.editors[1]?.position).toEqual({ lineNumber: 4, column: 1 });
  });

  it('тема — по .dark окна', async () => {
    render(<MonacoEditor {...props()} />);
    await mounted();
    await waitFor(() => expect(monacoMock.themes.at(-1)).toBe(false));
    act(() => useUiStore.setState({ dark: true }));
    await waitFor(() => expect(monacoMock.themes.at(-1)).toBe(true));
  });
});
