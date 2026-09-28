/**
 * Сравнение «диск ↔ буфер» (кусок 7.3b, спека 10.5): Monaco diff — режим той же вкладки файла
 * (`FileBody`), а не отдельная вкладка: вида для неё в раскладке нет. Обе стороны только для
 * чтения: решение — кнопками баннера над ним («Reload», «Keep mine») или «Close» — назад к правке.
 */

import { useMemo } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import { useUiStore } from '../../store/ui.js';
import { useMonacoReady } from './MonacoEditor.js';

export interface CompareViewProps {
  /** Текст на диске. */
  original: string;
  /** Текст буфера. */
  modified: string;
  /**
   * Пути моделей сторон: язык — по расширению, поэтому имя файла в конце у обеих. Свои, не путь
   * редактора вкладки: его модель сравнение не трогает.
   */
  modelPaths: { original: string; modified: string };
  fontFamily: string;
  fontSize: number;
}

export function CompareView({ original, modified, modelPaths, fontFamily, fontSize }: CompareViewProps): JSX.Element {
  const status = useMonacoReady();
  const dark = useUiStore((state) => state.dark);
  const options = useMemo(
    () => ({
      fontFamily,
      fontSize: Math.max(1, fontSize - 1),
      minimap: { enabled: false },
      renderWhitespace: 'selection' as const,
      scrollBeyondLastLine: false,
      readOnly: true,
      originalEditable: false,
      automaticLayout: true,
    }),
    [fontFamily, fontSize],
  );
  if (status instanceof Error) throw status;
  if (status === 'loading') return <div className="h-full" />;
  return (
    <div data-testid="file-compare" className="h-full min-h-0">
      <DiffEditor
        className="h-full"
        original={original}
        modified={modified}
        originalModelPath={modelPaths.original}
        modifiedModelPath={modelPaths.modified}
        theme={dark ? 'harnas-dark' : 'harnas-light'}
        loading={null}
        options={options}
      />
    </div>
  );
}
