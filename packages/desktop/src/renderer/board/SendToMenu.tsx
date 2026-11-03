/** Меню Send to… на карточке Backlog: живые сессии и комнаты проекта, затем New session… и New room…. */
import { useMemo } from 'react';
import { Button } from '../ui/button.js';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '../ui/dropdown-menu.js';
import { S } from '../../shared/strings.js';
import { workKey } from '../../shared/work-keys.js';
import { useLayoutStore } from '../layout/store.js';
import { folderName } from '../sidebar/sort.js';
import { useWorksStore } from '../store/works.js';
import { cardKey } from './board-model.js';
import { liveTargets, openCardInDialog, scheduleSend } from './board-send.js';
import type { SendTarget } from './board-send.js';
import type { BoardCard } from './board-model.js';
import { useBoardStore } from './board-store.js';
import type { BoardBridge } from './board-store.js';

export interface SendToMenuProps { bridge: BoardBridge; card: BoardCard }

export function SendToMenu({ bridge, card }: SendToMenuProps): JSX.Element {
  const { project } = card;
  const entries = useWorksStore(s => s.entries);
  const activeKey = useLayoutStore(s => s.activeWorkKey);
  const sending = useBoardStore(s => s.sending.has(cardKey(card)));
  const targets = useMemo(() => liveTargets(project, entries), [project, entries]);
  // Работа нового сеанса: первая активная работа проекта в порядке его путей; у «Входящих» — работа активной вкладки.
  const dialogWork = useMemo(() => {
    if (project.inbox) return entries.find(entry => entry.map.work.status === 'active' && workKey(entry.projectPath, entry.map.work.id) === activeKey) ?? null;
    // `paths` отсортирован по алфавиту, и worktree может стоять в нём раньше основной копии, поэтому основной путь идёт первым явно.
    for (const path of [project.projectPath, ...project.paths]) {
      const entry = entries.find(row => row.projectPath === path && row.map.work.status === 'active');
      if (entry) return entry;
    }
    return null;
  }, [project, entries, activeKey]);
  // Цели «Входящих» группируются по проекту; у остальных проектов группа одна и заголовок не нужен.
  const groups = useMemo(() => {
    const byProject = new Map<string, SendTarget[]>();
    for (const target of targets) {
      const list = byProject.get(target.entry.projectPath);
      if (list) list.push(target); else byProject.set(target.entry.projectPath, [target]);
    }
    return [...byProject];
  }, [targets]);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" size="sm" variant="outline" data-card-action="send-to" disabled={sending}>{S.board.sendTo}</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {targets.length === 0 && <DropdownMenuItem disabled>{S.board.noTargets}</DropdownMenuItem>}
        {groups.map(([path, list]) => (
          <div key={path}>
            {project.inbox && <DropdownMenuLabel>{folderName(path)}</DropdownMenuLabel>}
            {list.map(target => (
              <DropdownMenuItem key={`${target.kind}:${target.entry.projectPath}:${target.entry.map.work.id}:${target.id}`}
                data-send-target={`${target.entry.map.work.id}/${target.id}`} onSelect={() => scheduleSend(bridge, card, target)}>
                <span className="truncate">{target.label}</span>
              </DropdownMenuItem>
            ))}
          </div>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem data-send-new="session" disabled={dialogWork === null}
          {...(dialogWork === null ? { title: S.backlog.noWorkspace } : null)}
          onSelect={() => { if (dialogWork) void openCardInDialog(bridge, card, dialogWork, 'session'); }}>{S.board.newSession}</DropdownMenuItem>
        <DropdownMenuItem data-send-new="room" disabled={dialogWork === null}
          {...(dialogWork === null ? { title: S.backlog.noWorkspace } : null)}
          onSelect={() => { if (dialogWork) void openCardInDialog(bridge, card, dialogWork, 'room'); }}>{S.board.newRoom}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
