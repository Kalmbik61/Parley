/** Вид доски: шапка с фильтром и Refresh, четыре колонки, пустая доска и открытая карточка. */
import { useMemo, useState } from 'react';
import { S } from '../../shared/strings.js';
import type { ParleyBridge } from '../../shared/bridge.js';
import { folderName } from '../sidebar/sort.js';
import { useActivityStore } from '../store/activity.js';
import { useWorksStore } from '../store/works.js';
import { boardColumns, cardKey, resolveTaken } from './board-model.js';
import type { BoardCard, BoardFilter } from './board-model.js';
import { useBoardProjects, useBoardStore } from './board-store.js';
import { BoardCardView } from './BoardCardView.js';
import { BoardColumn } from './BoardColumn.js';
import { CardDialog } from './CardDialog.js';
import { targetInfo } from './target-info.js';

const filterValue = (filter: BoardFilter, keys: ReadonlyMap<string, string>): string => {
  if (filter.kind === 'inbox') return 'inbox';
  // Проекта фильтра среди проектов доски нет: селект показывает его отдельным пунктом, а не «All projects».
  if (filter.kind === 'project') return keys.get(filter.path) ?? `p:${filter.path}`;
  return 'all';
};

export function BoardView({ bridge }: { bridge: ParleyBridge }): JSX.Element {
  const supported = useBoardStore(state => state.supported);
  const filter = useBoardStore(state => state.filter);
  const setFilter = useBoardStore(state => state.setFilter);
  const refresh = useBoardStore(state => state.refresh);
  const projects = useBoardProjects();
  const entries = useWorksStore(state => state.entries);
  const activity = useActivityStore(state => state.byRef);
  const [showOlder, setShowOlder] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const columns = useMemo(() => boardColumns(projects, filter, today), [projects, filter, today]);

  if (!supported) {
    return <div className="p-(--space-4) text-sm text-muted-foreground">{S.board.unavailable}</div>;
  }

  // Любой путь группы (ключ, основная копия, worktree) ведёт к одному пункту списка.
  const keys = new Map<string, string>();
  for (const project of projects) {
    if (project.inbox) continue;
    for (const path of [project.key, ...project.paths]) keys.set(path, `p:${project.key}`);
  }
  const stale = projects.filter(project => !project.live);
  const missingPath = filter.kind === 'project' && !keys.has(filter.path) ? filter.path : null;
  const all = [...columns.backlog, ...columns.inProgress, ...columns.review, ...columns.done, ...columns.olderDone];
  const empty = all.length === 0;
  const doneCards = showOlder ? [...columns.done, ...columns.olderDone] : columns.done;
  const opened = openKey === null ? null : (all.find(card => cardKey(card) === openKey) ?? null);

  const infoFor = (card: BoardCard) =>
    card.state === 'in-progress' || card.state === 'review' || opened === card
      ? targetInfo(resolveTaken(card.item.taken, card.project, entries), activity, now)
      : null;
  const renderCard = (card: BoardCard): JSX.Element => (
    <BoardCardView key={cardKey(card)} bridge={bridge} card={card} target={infoFor(card)} onOpen={next => setOpenKey(cardKey(next))} />
  );

  const onFilter = (value: string): void => {
    if (value === 'all') setFilter({ kind: 'all' });
    else if (value === 'inbox') setFilter({ kind: 'inbox' });
    else {
      const project = projects.find(row => `p:${row.key}` === value);
      if (project) setFilter({ kind: 'project', path: project.key });
    }
  };
  const onRefresh = (): void => {
    for (const project of stale) for (const path of project.paths) void refresh(bridge, path);
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-(--space-3)">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h2 className="shrink-0 font-heading text-lg">{S.board.title}</h2>
        <select
          aria-label={S.board.filter}
          className="min-w-0 max-w-[260px] truncate rounded-md bg-background px-2 py-1 text-sm"
          value={filterValue(filter, keys)}
          onChange={event => onFilter(event.target.value)}
        >
          <option value="all">{S.board.allProjects}</option>
          {projects.map(project => (
            <option key={project.key} value={project.inbox ? 'inbox' : `p:${project.key}`}>{project.title}</option>
          ))}
          {missingPath !== null && <option value={`p:${missingPath}`}>{folderName(missingPath)}</option>}
        </select>
        {stale.length > 0 && (
          <button type="button" className="shrink-0 rounded-md px-2 py-1 text-sm hover:bg-accent" onClick={onRefresh}>{S.board.refresh}</button>
        )}
      </div>
      {stale.length > 0 && <p className="text-xs text-muted-foreground">{S.board.liveUnavailable}</p>}
      {empty ? (
        <div className="flex flex-col gap-1 text-sm">
          <p>{S.board.empty}</p>
          <p className="text-muted-foreground">{S.board.emptyHint}</p>
        </div>
      ) : null}
      <div className="scrollbar-sleek flex min-h-0 flex-1 gap-3 overflow-x-auto">
        <BoardColumn title={S.board.columns.backlog} count={columns.backlog.length}>{columns.backlog.map(renderCard)}</BoardColumn>
        <BoardColumn title={S.board.columns.inProgress} count={columns.inProgress.length}>{columns.inProgress.map(renderCard)}</BoardColumn>
        <BoardColumn title={S.board.columns.review} count={columns.review.length}>{columns.review.map(renderCard)}</BoardColumn>
        <BoardColumn title={S.board.columns.done} count={columns.done.length}>
          {doneCards.map(renderCard)}
          {columns.olderDone.length > 0 && (
            <li>
              <button type="button" className="text-xs text-muted-foreground hover:underline" onClick={() => setShowOlder(value => !value)}>
                {showOlder ? S.board.hideOlder : S.board.showOlder(columns.olderDone.length)}
              </button>
            </li>
          )}
        </BoardColumn>
      </div>
      <CardDialog bridge={bridge} card={opened} target={opened === null ? null : infoFor(opened)} onClose={() => setOpenKey(null)} />
    </div>
  );
}
