/**
 * Вкладка «Изменения» правого сайдбара (кусок 8.2b, спека 11.1, 11.2): шапка `ветка → база`,
 * главная кнопка и секции. Данные — `useChanges` (8.2a), решения — `review/state.ts`; здесь только
 * разметка и явные действия человека.
 *
 * Хост старее окна (решение сверки I9): его `worktrees.diff` отвечает без `stats`, `commits` и
 * `mergeBase` — без `worktrees.mergeCheck` (признак хоста этапа 8) вместо тела кнопка перезапуска
 * и ни одного вызова.
 *
 * «Отбросить worktree…» — двухшаговый поток прежней панели как есть: второй вопрос — своё
 * состояние, потому что `ConfirmDialog` сам закрывается после `onConfirm`, и общий флаг стёр бы
 * переход на второй шаг. Отброшенный worktree закрытой сессии хост оставляет в карте — вкладка
 * помнит его в сторе ревью и показывает своё состояние, а не ошибку git (перенос 8.2b).
 */

import { useState, type CSSProperties } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { toast } from 'sonner';
import type { BranchCommit, DiffFile, WorkEntry } from '@harnas/core';
import { refKey, type SessionRef } from '@harnas/protocol';
import type { HarnasBridge } from '../../shared/bridge.js';
import { decodeIpcError } from '../../shared/ipc-error.js';
import { errorText, S } from '../../shared/strings.js';
import { ConfirmDialog } from '../components/dialogs/ConfirmDialog.js';
import { fileTabIds } from '../files/close-guard.js';
import { tabId } from '../layout/ids.js';
import { useLayoutStore } from '../layout/store.js';
import { openTab } from '../layout/tree.js';
import { useHostSupports } from '../lib/capabilities.js';
import { cn } from '../lib/cn.js';
import { sessionRowLabel, sessionTag } from '../lib/participant.js';
import { useActivityStore } from '../store/activity.js';
import { useHostStore } from '../store/host.js';
import { useUiStore } from '../store/ui.js';
import type { SendWithToastDeps } from '../terminal/send.js';
import { Button } from '../ui/button.js';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select.js';
import { ConflictsSection } from './ConflictsSection.js';
import { PrimaryAction } from './PrimaryAction.js';
import { Section } from './Section.js';
import { changesSections, type ChangesSource } from './state.js';
import { changesSessionOf, useReviewStore } from './store.js';
import { useChanges } from './use-changes.js';
import { VirtualRows } from './VirtualRows.js';

export interface ChangesPanelProps {
  bridge: HarnasBridge;
  workKey: string;
  /** Активная работа. */
  entry: WorkEntry;
  /** `SendWithToastDeps` окна, из `AppShell` (7.2). */
  sendDeps: SendWithToastDeps;
}

type SectionKey = 'conflicts' | 'uncommitted' | 'branch' | 'commits';

const FILE_STATUS: Record<string, string> = S.changes.fileStatus;

function Centered({ children }: { children: string }): JSX.Element {
  return <div className="flex flex-1 items-center justify-center p-4 text-center text-sm text-muted-foreground">{children}</div>;
}

/** Высота строки файла (`h-[30px]`, пилюли от 30px — спека окна 2026-09-29, 1.8) — шаг виртуального списка. */
const FILE_ROW_HEIGHT = 30;

/**
 * Строка правого сайдбара — пилюля с заливкой hover `text 6 %`. Вторичный текст внутри (буква статуса, автор
 * коммита) на этой заливке ниже 4.5:1 (наследство куска 1), поэтому на hover его цвет — основной: класс
 * подменяет переменную вторичного цвета для всего поддерева строки. Так же цвет текста успеха (`+N`,
 * accent-2-700: 4.31:1 на этой заливке в светлой теме): токен подменяется ступенью 800 (правки ревью куска 2);
 * `−N` (accent-700, 4.55:1) порог держит сам.
 */
const ROW_HOVER =
  'transition-colors hover:bg-foreground/6 hover:[--muted-foreground:var(--foreground)] hover:[--status-success-text:var(--color-accent-2-800)]';

function FileRow({ file, onOpen, style }: { file: DiffFile; onOpen(): void; style?: CSSProperties }): JSX.Element {
  const title = file.oldPath === null ? file.path : `${file.oldPath} → ${file.path}`;
  return (
    <li className="min-w-0" {...(style === undefined ? null : { style })}>
      <button
        type="button"
        title={title}
        className={cn('flex h-[30px] w-full min-w-0 items-center gap-2 rounded-full px-3 text-left text-xs', ROW_HOVER)}
        onClick={onOpen}
      >
        <span className="w-3 shrink-0 font-mono text-[11px] font-bold text-muted-foreground" title={FILE_STATUS[file.status] ?? file.status}>
          {file.status}
        </span>
        <span className="min-w-0 flex-1 truncate">{file.path}</span>
        {/* Двоичный файл чисел не имеет (numstat `-`). `+N` — accent-2-700, `−N` — accent-700 (1.8). */}
        {file.additions === null ? null : <span className="shrink-0 text-[11px] font-semibold tabular-nums text-status-success-text">{`+${file.additions}`}</span>}
        {file.deletions === null ? null : <span className="shrink-0 text-[11px] font-semibold tabular-nums text-accent-700">{`−${file.deletions}`}</span>}
      </button>
    </li>
  );
}

function CommitRow({ commit, onOpen }: { commit: BranchCommit; onOpen(): void }): JSX.Element {
  const when = new Date(commit.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return (
    <li className="min-w-0">
      <button
        type="button"
        title={`${commit.hash.slice(0, 7)} ${commit.subject}\n${commit.author} · ${when}`}
        className={cn('flex w-full min-w-0 flex-col rounded-2xl px-3 py-1.5 text-left text-xs', ROW_HOVER)}
        onClick={onOpen}
      >
        <span className="flex w-full min-w-0 items-center gap-2">
          <span className="shrink-0 font-mono text-muted-foreground">{commit.hash.slice(0, 7)}</span>
          <span className="truncate">{commit.subject}</span>
        </span>
        <span className="w-full truncate text-muted-foreground">{`${commit.author} · ${when}`}</span>
      </button>
    </li>
  );
}

export function ChangesPanel({ bridge, workKey, entry, sendDeps }: ChangesPanelProps): JSX.Element {
  const supported = useHostSupports('worktrees.mergeCheck');
  const connected = useHostStore((state) => state.status.state === 'connected');
  const chosen = useReviewStore((state) => state.changesSession);
  const sessionId = useLayoutStore((state) => changesSessionOf({ changesSession: chosen }, state, workKey, entry));
  const session = sessionId === null ? undefined : entry.map.sessions.find((candidate) => candidate.id === sessionId);
  const ref: SessionRef | null = sessionId === null ? null : { projectPath: entry.projectPath, workId: entry.map.work.id, sessionId };
  const key = ref === null ? null : refKey(ref);
  const discarded = useReviewStore((state) => key !== null && state.discarded[key] === true);
  const working = useActivityStore((state) => key !== null && state.byRef[key]?.activity.activity === 'working');

  // Старый хост, нет связи или отброшенный worktree — загрузки нет вовсе: sessionId: null.
  const loadable = supported && !discarded ? sessionId : null;
  const { source, error, refresh } = useChanges({ bridge, entry, sessionId: loadable });

  // Файлы ответа `conflict` слияния — до следующего обновления: живут, пока `source` тот же объект.
  const [mergeConflicts, setMergeConflicts] = useState<{ files: string[]; source: ChangesSource } | null>(null);
  const [collapsed, setCollapsed] = useState<Partial<Record<SectionKey, boolean>>>({});
  const [discardFirst, setDiscardFirst] = useState(false);
  const [discardSecond, setDiscardSecond] = useState(false);
  // Прокрутчик секций — элементом в состоянии: см. `VirtualRows`.
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);

  if (connected && !supported) {
    return (
      <div className="flex flex-1 items-center justify-center p-4">
        <Button type="button" variant="outline" size="sm" onClick={() => useUiStore.getState().confirmRestartHost()}>
          {S.statusBar.hostOutdated}
        </Button>
      </div>
    );
  }

  const toggle = (section: SectionKey): void => setCollapsed((current) => ({ ...current, [section]: current[section] !== true }));
  const isOpen = (section: SectionKey): boolean => collapsed[section] !== true;

  const openDiff = (commit: string | null): string | null => {
    if (sessionId === null) return null;
    const id = tabId.diff(sessionId, commit);
    useLayoutStore.getState().apply(workKey, (layout) => openTab(layout, { kind: 'diff', id, sessionId, commit }));
    return id;
  };
  // Переход к файлу во вкладке диффа делает 8.3 по разовой записи стора ревью.
  const openFile = (path: string): void => {
    const id = openDiff(null);
    if (id !== null) useReviewStore.getState().revealFile(workKey, id, path);
  };

  const worktree = session?.worktree ?? null;
  const canDiscard = ref !== null && worktree !== null && worktree.createdAt !== null && !discarded;
  const discard = (force: boolean): void => {
    if (ref === null || key === null) return;
    // Вкладки файлов этого worktree — сначала, с вопросом о несохранённых (раунд fix-final-c, п. 3),
    // как у «Delete» сессии: иначе папка уходит из-под буферов с правками молча. «Отмена» — worktree
    // не отбрасывается.
    const store = useLayoutStore.getState();
    const own = fileTabIds(store.layouts[workKey], (root) => root.kind === 'worktree' && root.sessionId === ref.sessionId);
    const closing = own.length === 0 ? Promise.resolve(true) : store.requestCloseTabs(workKey, own);
    void closing.then((closed) => {
      if (closed) callDiscard(ref, key, force);
    });
  };
  const callDiscard = (ref: SessionRef, key: string, force: boolean): void => {
    bridge.call('worktrees.discard', { ref, force }).then(
      // Своё обновление не нужно: отброшенному worktree `worktrees.diff` отвечать нечем — состояние из стора.
      () => useReviewStore.getState().markDiscarded(key),
      (err: unknown) => {
        const info = decodeIpcError(err);
        console.warn('[harnas] worktrees.discard', info.code, info.message);
        toast.error(errorText(info.code, S.errors.actions.discardWorktree));
      },
    );
  };

  const header = (
    <div className="flex h-9 shrink-0 items-center gap-1 px-1">
      <Select value={sessionId ?? ''} onValueChange={(next) => useReviewStore.getState().selectChangesSession(workKey, next)}>
        <SelectTrigger
          aria-label={S.changes.sessionPicker}
          // Выбор сессии — заголовок панели (спека окна 2026-09-29, 1.8: Caprasimo 17px), как в «Файлах».
          className="h-8 min-w-0 flex-1 border-transparent bg-transparent px-2 font-heading text-[17px] leading-[1.2] hover:border-transparent hover:bg-foreground/6"
          title={session === undefined ? S.changes.sessionPicker : sessionRowLabel(session.id, session.label)}
        >
          <SelectValue placeholder={S.changes.sessionPicker} />
        </SelectTrigger>
        <SelectContent>
          {entry.map.sessions.map((candidate) => {
            const label = sessionRowLabel(candidate.id, candidate.label);
            return (
              <SelectItem key={candidate.id} value={candidate.id} title={label} className="text-xs">
                <span className="block max-w-[min(480px,80vw)] truncate">{label}</span>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="icon-xs" aria-label={S.changes.headerMenu} title={S.changes.headerMenu}>
            <MoreHorizontal className="size-3.5" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={refresh}>{S.files.refresh}</DropdownMenuItem>
          {canDiscard ? (
            <DropdownMenuItem className="text-destructive" onSelect={() => setDiscardFirst(true)}>
              {S.changes.discardWorktreeEllipsis}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  let summary: JSX.Element | null = null;
  if (source?.kind === 'worktree') {
    const heading = `${source.branch} → ${source.base}`;
    summary = (
      <div className="flex min-w-0 shrink-0 items-center gap-2 px-3 py-1 text-xs">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={heading}>
          {heading}
        </span>
        {/* Два цвета (1.8): `+N` accent-2-700, `−N` accent-700; не --destructive — тот в светлой accent-800. */}
        <span className="shrink-0 font-bold tabular-nums">
          <span className="text-status-success-text">{`+${source.diff.stats.additions}`}</span>{' '}
          <span className="text-accent-700">{`−${source.diff.stats.deletions}`}</span>
        </span>
        <span className="shrink-0 text-muted-foreground">{S.changes.commitCount(source.diff.commits.length)}</span>
      </div>
    );
  } else if (source?.kind === 'project') {
    const folder = S.changes.projectFolder(source.changes.branch);
    summary = (
      <div className="flex min-w-0 shrink-0 flex-col gap-0.5 px-3 py-1 text-xs">
        <span className="truncate font-mono text-[11px] text-muted-foreground" title={folder}>
          {folder}
        </span>
        <span className="text-status-warning-text">{S.changes.projectFolderWarning}</span>
      </div>
    );
  } else if (source?.kind === 'pending') {
    summary = <div className="shrink-0 px-3 py-1 text-xs text-muted-foreground">{S.changes.worktreePending}</div>;
  }

  let body: JSX.Element;
  if (ref === null) body = <Centered>{S.changes.noSession}</Centered>;
  else if (discarded) body = <Centered>{S.changes.worktreeDiscarded}</Centered>;
  else if (error !== null) body = <Centered>{error}</Centered>;
  else if (source === null) body = <Centered>{S.changes.loading}</Centered>;
  else {
    const { uncommitted, branch, moreUntracked } = changesSections(source);
    const fileRows = (files: DiffFile[]): JSX.Element => (
      <VirtualRows
        scroller={scroller}
        items={files}
        rowHeight={FILE_ROW_HEIGHT}
        itemKey={(file) => file.path}
        renderRow={(file, style) => <FileRow key={file.path} file={file} style={style} onOpen={() => openFile(file.path)} />}
      />
    );
    const conflicts =
      mergeConflicts !== null && mergeConflicts.source === source
        ? mergeConflicts.files
        : source.kind === 'worktree' && source.check?.status === 'conflicts'
          ? source.check.files
          : [];
    body = (
      <>
        <PrimaryAction
          // Черновик сообщения — одной сессии: смена сессии в шапке начинает с пустого поля.
          key={key}
          bridge={bridge}
          workKey={workKey}
          sessionRef={ref}
          source={source}
          working={working}
          sendDeps={sendDeps}
          onChanged={refresh}
          onConflicts={(files) => {
            setMergeConflicts({ files, source });
            setCollapsed((current) => ({ ...current, conflicts: false }));
          }}
        />
        <div ref={setScroller} data-rows-scroll className="flex min-h-0 flex-1 flex-col overflow-y-auto py-1">
          <ConflictsSection files={conflicts} open={isOpen('conflicts')} onToggle={() => toggle('conflicts')} onOpenFile={openFile} />
          {source.kind === 'pending' ? null : (
            <Section
              title={S.changes.sections.uncommitted}
              count={uncommitted.length + moreUntracked}
              open={isOpen('uncommitted')}
              onToggle={() => toggle('uncommitted')}
            >
              {fileRows(uncommitted)}
              {moreUntracked > 0 ? (
                <li className="flex h-6 min-w-0 items-center px-3 text-xs text-muted-foreground" title={S.changes.moreUntrackedHint}>
                  <span className="truncate">{S.changes.moreUntracked(moreUntracked)}</span>
                </li>
              ) : null}
            </Section>
          )}
          {source.kind === 'worktree' ? (
            <>
              <Section title={S.changes.sections.branchChanges} count={branch.length} open={isOpen('branch')} onToggle={() => toggle('branch')}>
                {fileRows(branch)}
              </Section>
              <Section title={S.changes.sections.commits} count={source.diff.commits.length} open={isOpen('commits')} onToggle={() => toggle('commits')}>
                {source.diff.commits.map((commit) => (
                  <CommitRow key={commit.hash} commit={commit} onOpen={() => openDiff(commit.hash)} />
                ))}
              </Section>
            </>
          ) : null}
        </div>
      </>
    );
  }

  return (
    <div data-testid="changes-panel" className="flex min-h-0 flex-1 flex-col">
      {header}
      {ref !== null && !discarded && error === null ? summary : null}
      {body}
      <ConfirmDialog
        open={discardFirst}
        title={S.changes.discardWorktreeTitle(sessionTag(sessionId ?? ''))}
        description={S.changes.discardWorktreeDescription}
        confirmLabel={S.changes.discard}
        onConfirm={() => {
          // Незакоммиченное пропадёт — только второй вопрос шлёт force: true.
          if (source?.kind === 'worktree' && source.diff.uncommitted) setDiscardSecond(true);
          else discard(false);
        }}
        onOpenChange={setDiscardFirst}
      />
      <ConfirmDialog
        open={discardSecond}
        title={S.changes.discardAllConfirmTitle}
        confirmLabel={S.changes.discardAllConfirm}
        onConfirm={() => discard(true)}
        onOpenChange={setDiscardSecond}
      />
    </div>
  );
}
