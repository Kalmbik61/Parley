/**
 * Фильтр `unhandledrejection` редактора (раунд fix-7.3, п. 7): гасится только отмена самого
 * Monaco, а не любая `Error('Canceled')` окна.
 */

import { describe, expect, it } from 'vitest';
import { isMonacoCancel } from './monaco-cancel.js';

function canceled(stack: string): Error {
  const error = new Error('Canceled');
  error.name = 'Canceled';
  error.stack = `Canceled: Canceled\n${stack}`;
  return error;
}

const CHUNK = 'file:///app/out/renderer/assets/MonacoEditor-CWY7adJZ.js';

describe('isMonacoCancel', () => {
  it('отмена из кода Monaco — собранный чанк или пакет monaco-editor в dev — да', () => {
    expect(isMonacoCancel(canceled(`    at t.cancel (${CHUNK}:12:345)`), CHUNK)).toBe(true);
    expect(
      isMonacoCancel(canceled('    at x (http://localhost:5173/node_modules/.vite/deps/monaco-editor_esm_vs_base_common_errors.js:1:2)'), 'http://localhost:5173/src/renderer/files/editor/monaco-setup.ts'),
    ).toBe(true);
  });

  it('та же отмена из чужого кода окна — нет; не отмена — нет', () => {
    expect(isMonacoCancel(canceled('    at abort (file:///app/out/renderer/assets/index-abc.js:1:2)'), CHUNK)).toBe(false);
    const other = new Error('Canceled');
    expect(isMonacoCancel(other, CHUNK)).toBe(false);
    expect(isMonacoCancel('Canceled', CHUNK)).toBe(false);
  });
});
