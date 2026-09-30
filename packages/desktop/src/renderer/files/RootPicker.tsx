/**
 * Выбор корня «Файлов» (кусок 7.2, спека 10.1): папка проекта и worktree сессий работы, у
 * которых он создан (`⎇ S02 · harnas/w-0003/s02`). Выбор держится в `files/store.ts`, пока
 * человек его не сменит.
 */

import type { WorkEntry } from '@harnas/core';
import type { FileRootSpec } from '../../shared/layout-types.js';
import { S } from '../../shared/strings.js';
import { sessionTag } from '../lib/participant.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select.js';

export interface RootOption {
  value: string;
  label: string;
  spec: FileRootSpec;
}

function valueOf(spec: FileRootSpec): string {
  return spec.kind === 'project' ? 'project' : `worktree:${spec.sessionId}`;
}

/** «Project» и worktree каждой сессии с созданной папкой (`createdAt !== null`). */
export function rootOptions(entry: WorkEntry): RootOption[] {
  const options: RootOption[] = [{ value: 'project', label: S.files.project, spec: { kind: 'project' } }];
  for (const session of entry.map.sessions) {
    const worktree = session.worktree;
    if (worktree === null || worktree.createdAt === null) continue;
    const spec: FileRootSpec = { kind: 'worktree', sessionId: session.id };
    options.push({ value: valueOf(spec), label: S.files.worktreeRoot(sessionTag(session.id), worktree.branch), spec });
  }
  return options;
}

export interface RootPickerProps {
  entry: WorkEntry;
  value: FileRootSpec;
  onChange(spec: FileRootSpec): void;
}

export function RootPicker({ entry, value, onChange }: RootPickerProps): JSX.Element {
  const options = rootOptions(entry);
  const selected = options.find((option) => option.value === valueOf(value));
  return (
    <Select
      value={valueOf(value)}
      onValueChange={(next) => {
        const option = options.find((candidate) => candidate.value === next);
        if (option !== undefined) onChange(option.spec);
      }}
    >
      {/* Ветка бывает длиннее сайдбара: обрезка многоточием, полный текст — в title. Выбор корня — заголовок
          панели (спека окна 2026-09-29, 1.8: Caprasimo 17px): без рамки, она вернётся на фокусе и пока
          список открыт. */}
      <SelectTrigger className="h-8 min-w-0 flex-1 border-transparent bg-transparent px-2 font-heading text-[17px] leading-[1.2] hover:border-transparent hover:bg-foreground/6" title={selected?.label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} title={option.label} className="text-xs">
            <span className="block max-w-[min(480px,80vw)] truncate">{option.label}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
