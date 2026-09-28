/**
 * Размонтирование Monaco `DiffEditor` (`@monaco-editor/react` 4.7) без ошибки: библиотека на
 * размонтировании диспозит модели сторон раньше самого редактора, а Monaco на это бросает
 * «TextModel got disposed before DiffEditorWidget model got reset» (pageerror на собранном окне —
 * вкладка диффа 8.3 и сравнение файла 7.3b, приёмка этапа 7). Эффект компонента-родителя снимается
 * раньше эффекта `DiffEditor`: там модели сначала отвязываются от редактора, затем диспозятся —
 * библиотеке остаётся редактор без моделей.
 */

/** Что помощник трогает у diff-редактора Monaco. */
export interface ReleasableDiffEditor {
  getModel(): { original: { dispose(): void }; modified: { dispose(): void } } | null;
  setModel(model: null): void;
}

export function releaseDiffEditor(editor: ReleasableDiffEditor | null): void {
  if (editor === null) return;
  const models = editor.getModel();
  editor.setModel(null);
  models?.original.dispose();
  models?.modified.dispose();
}
