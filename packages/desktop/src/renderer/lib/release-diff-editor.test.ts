import { describe, expect, it } from 'vitest';
import { releaseDiffEditor } from './release-diff-editor.js';

describe('releaseDiffEditor (fix-7-accept п. 1)', () => {
  it('сначала отвязывает модели от редактора, затем диспозит обе', () => {
    const calls: string[] = [];
    let attached = true;
    const editor = {
      getModel: () =>
        attached
          ? { original: { dispose: () => calls.push('original.dispose') }, modified: { dispose: () => calls.push('modified.dispose') } }
          : null,
      setModel: (model: null) => {
        calls.push(`setModel(${String(model)})`);
        attached = false;
      },
    };
    releaseDiffEditor(editor);
    expect(calls).toEqual(['setModel(null)', 'original.dispose', 'modified.dispose']);
  });

  it('редактора нет или моделей нет — без ошибок', () => {
    expect(() => releaseDiffEditor(null)).not.toThrow();
    const calls: string[] = [];
    releaseDiffEditor({ getModel: () => null, setModel: () => calls.push('setModel') });
    expect(calls).toEqual(['setModel']);
  });
});
