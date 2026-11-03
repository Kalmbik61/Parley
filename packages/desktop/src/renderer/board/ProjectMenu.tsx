/** Меню проекта в шапке доски (фильтр — один проект): правило предложений, файл бэклога и Open file. */
import { MoreHorizontal } from 'lucide-react';
import { useState } from 'react';
import type { BacklogFileChoice, BacklogRule, BacklogSnapshot } from '@parley/protocol';
import { S } from '../../shared/strings.js';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '../ui/dropdown-menu.js';
import type { BoardProject } from './board-model.js';
import { useBoardStore } from './board-store.js';
import type { BoardBridge } from './board-store.js';

const RULES: readonly { rule: BacklogRule; label: string }[] = [
  { rule: 'ask', label: S.backlog.ask },
  { rule: 'problems', label: S.backlog.problems },
  { rule: 'everything', label: S.backlog.everything },
];

export interface ProjectMenuProps {
  bridge: BoardBridge;
  project: BoardProject;
  onOpenFile(projectPath: string): void;
}

export function ProjectMenu({ bridge, project, onOpenFile }: ProjectMenuProps): JSX.Element {
  const [failed, setFailed] = useState(false);
  const { snapshot, projectPath } = project;
  const choice = snapshot.file.choice;

  const run = async (call: () => Promise<BacklogSnapshot>): Promise<void> => {
    setFailed(false);
    try {
      useBoardStore.getState().apply(await call());
    } catch {
      setFailed(true);
    }
  };
  const setRule = (rule: BacklogRule): void => { void run(() => bridge.call('backlog.preferences.set', { projectPath, rule })); };
  const setFile = (file: BacklogFileChoice): void => { void run(() => bridge.call('backlog.file.set', { projectPath, file })); };

  return (
    <div className="flex shrink-0 items-center gap-1">
      {failed && <span role="alert" className="text-xs text-destructive">{S.board.failed}</span>}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={S.board.projectMenu}
            title={S.board.projectMenu}
            onClick={event => event.stopPropagation()}
            className="inline-flex size-7 items-center justify-center rounded-md hover:bg-accent data-[state=open]:bg-accent"
          >
            <MoreHorizontal className="size-4" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>{S.backlog.agentSuggestions}</DropdownMenuLabel>
          {RULES.map(row => (
            <DropdownMenuCheckboxItem key={row.rule} checked={snapshot.rule === row.rule} onSelect={() => setRule(row.rule)}>{row.label}</DropdownMenuCheckboxItem>
          ))}
          {choice !== undefined && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>{S.backlog.file}</DropdownMenuLabel>
              <DropdownMenuCheckboxItem checked={(choice ?? 'state') === 'state'} onSelect={() => setFile('state')}>{S.backlog.stateFile}</DropdownMenuCheckboxItem>
              {snapshot.file.todos != null && (
                <DropdownMenuCheckboxItem checked={choice === 'todos'} onSelect={() => setFile('todos')}>{snapshot.file.todos}</DropdownMenuCheckboxItem>
              )}
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!snapshot.file.exists} onSelect={() => onOpenFile(projectPath)}>{S.backlog.openFile}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
