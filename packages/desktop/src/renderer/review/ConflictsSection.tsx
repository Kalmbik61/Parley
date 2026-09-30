/**
 * Секция «Конфликты» (кусок 8.2b, спека 11.1): файлы `worktrees.mergeCheck` со статусом
 * `conflicts` или файлы ответа `conflict` слияния — до следующего обновления. Пустой нет:
 * без конфликтов секция не рисуется.
 */

import { AlertTriangle } from 'lucide-react';
import { S } from '../../shared/strings.js';
import { Section } from './Section.js';

export interface ConflictsSectionProps {
  files: string[];
  open: boolean;
  onToggle(): void;
  /** Клик по файлу — вкладка диффа сессии на этом файле, как у прочих секций. */
  onOpenFile(path: string): void;
}

export function ConflictsSection({ files, open, onToggle, onOpenFile }: ConflictsSectionProps): JSX.Element | null {
  if (files.length === 0) return null;
  return (
    <Section title={S.changes.sections.conflicts} count={files.length} open={open} onToggle={onToggle}>
      {files.map((path) => (
        <li key={path} className="min-w-0">
          <button
            type="button"
            title={path}
            className="flex h-[30px] w-full min-w-0 items-center gap-2 rounded-full px-3 text-left text-xs transition-colors hover:bg-foreground/6"
            onClick={() => onOpenFile(path)}
          >
            <AlertTriangle className="size-3 shrink-0 text-status-warning" aria-hidden="true" />
            <span className="truncate">{path}</span>
          </button>
        </li>
      ))}
    </Section>
  );
}
