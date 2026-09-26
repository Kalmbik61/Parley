/**
 * Дифф по файлам (кусок 4.3 плана worktree, спека 8.2): `react-diff-view` +
 * `gitdiff-parser` — без HTML-строк и `dangerouslySetInnerHTML`, ханки рисует
 * сама библиотека из структурированных данных. Бинарный файл ханков не имеет
 * (`isBinary`) — вместо диффа строка «двоичный файл».
 */

import { Diff, Hunk } from 'react-diff-view';
import 'react-diff-view/style/index.css';
import { filePathOf, parsePatch, type GitDiffFile } from '../../lib/diff.js';

export interface DiffViewProps {
  /** Патч `worktrees.diff().patch` — весь дифф worktree одним текстом. */
  patch: string;
}

function FileDiff({ file }: { file: GitDiffFile }): JSX.Element {
  const path = filePathOf(file);
  return (
    <div className="rounded border border-[var(--h-overlay)]">
      <div className="border-b border-[var(--h-overlay)] px-2 py-1 font-mono text-xs text-[var(--h-subtext)]">
        {path}
      </div>
      {file.isBinary === true ? (
        <p className="px-2 py-2 text-xs text-[var(--h-muted)]">двоичный файл</p>
      ) : (
        <Diff viewType="unified" diffType={file.type} hunks={file.hunks}>
          {(hunks) => hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)}
        </Diff>
      )}
    </div>
  );
}

export function DiffView({ patch }: DiffViewProps): JSX.Element {
  const files = parsePatch(patch);

  if (files.length === 0) {
    return <p className="px-2 py-2 text-sm text-[var(--h-muted)]">Изменений нет</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {files.map((file) => (
        <FileDiff key={`${file.oldPath}\u0000${file.newPath}`} file={file} />
      ))}
    </div>
  );
}
