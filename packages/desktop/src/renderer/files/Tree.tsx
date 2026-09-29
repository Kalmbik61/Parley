/**
 * Дерево вкладки «Файлы» (кусок 7.2, спека 10.1). Папки читаются лениво — `files.list` только
 * при раскрытии, прочитанное держится в кэше до `treeChanged`: у проекта с тысячами файлов в
 * папке окно не читает всё дерево и не висит. Строк больше `VIRTUAL_AFTER` — виртуализация
 * `@tanstack/react-virtual`, как у сайдбара карточек.
 *
 * Корень дерева раскрыт всегда; раскрытые папки — в `files/store.ts` по ключу корня. Кэш папок
 * живёт в самом дереве: `FilesPanel` монтирует его с `key` корня, и смена корня начинает с
 * чистого кэша.
 *
 * Рамка (кусок 7.2): из дерева на диске ничего не создаётся и не удаляется; бросок файла на
 * терминал разбирает `AppShell` через `sendWithToast`.
 */

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, ChevronRight, File as FileIcon, Link2 } from 'lucide-react';
import { toast } from 'sonner';
import type { HarnasBridge } from '../../shared/bridge.js';
import type { DirEntry, FileRoot, GitStatusLetter } from '../../shared/files-types.js';
import { decodeIpcError } from '../../shared/ipc-error.js';
import type { TabSpec } from '../../shared/layout-types.js';
import { errorText, S } from '../../shared/strings.js';
import { rootKey as rootKeyOf } from '../../shared/work-keys.js';
import { dndId, type DragSourceData } from '../layout/dnd.js';
import { tabId } from '../layout/ids.js';
import { measureGroupSizes } from '../layout/measure.js';
import { useLayoutStore } from '../layout/store.js';
import { openTab, splitGroup } from '../layout/tree.js';
import { cn } from '../lib/cn.js';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '../ui/context-menu.js';
import { useFilesStore } from './store.js';

/** Высота строки дерева, px: пилюли 28 (спека окна 2026-09-29, 1.8, правый сайдбар). */
const ROW_HEIGHT = 28;
/** Отступ на уровень вложенности (спека 10.1). */
const INDENT = 18;
/** До стольких строк — обычный список: в маленьком дереве виртуализация только мешала бы. */
const VIRTUAL_AFTER = 200;

/** Цвет имени по букве git — токены палитры git (4.1). */
const GIT_COLOR: Record<GitStatusLetter, string> = {
  M: 'var(--git-decoration-modified)',
  A: 'var(--git-decoration-added)',
  D: 'var(--git-decoration-deleted)',
  U: 'var(--git-decoration-untracked)',
  R: 'var(--git-decoration-renamed)',
};

const EMPTY_SET: ReadonlySet<string> = new Set();
const COLLATOR = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

export interface TreeRow {
  path: string;
  name: string;
  depth: number;
  entry: DirEntry;
  /** Папка или симлинк на папку внутри корня: раскрывается. */
  dir: boolean;
  /** Файл или симлинк на файл внутри корня: открывается вкладкой. */
  openable: boolean;
}

function joinPath(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`;
}

const isDir = (entry: DirEntry): boolean => entry.kind === 'dir' || (entry.kind === 'symlink' && entry.target === 'dir');
const isOpenable = (entry: DirEntry): boolean => entry.kind === 'file' || (entry.kind === 'symlink' && entry.target === 'file');

/** Видимые строки: папки первыми, внутри — по имени без учёта регистра; игнорируемые — по флагу. */
export function flattenTree(
  dirs: Readonly<Record<string, DirEntry[]>>,
  expanded: ReadonlySet<string>,
  showIgnored: boolean,
): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (dir: string, depth: number): void => {
    const entries = dirs[dir];
    if (entries === undefined) return;
    const visible = entries.filter((entry) => showIgnored || !entry.ignored);
    visible.sort((a, b) => {
      const byKind = Number(isDir(b)) - Number(isDir(a));
      if (byKind !== 0) return byKind;
      return COLLATOR.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    });
    for (const entry of visible) {
      const path = joinPath(dir, entry.name);
      const dirRow = isDir(entry);
      rows.push({ path, name: entry.name, depth, entry, dir: dirRow, openable: isOpenable(entry) });
      if (dirRow && expanded.has(path)) walk(path, depth + 1);
    }
  };
  walk('', 0);
  return rows;
}

/** Вкладка файла в активной группе; `beside` — в новой группе справа (⌘-клик, «Open to the side»). Её же берут ⌘P и поиск (7.4). */
export function openFile(root: FileRoot, path: string, beside: boolean): void {
  const tab: TabSpec = { kind: 'file', id: tabId.file(root.spec, path), root: root.spec, path };
  const store = useLayoutStore.getState();
  if (!beside) {
    store.apply(root.workKey, (layout) => openTab(layout, tab));
    return;
  }
  // Отказ сообщается изнутри операции — как «Open to the side» строки сессии (3.4).
  store.apply(root.workKey, (layout) => {
    const result = splitGroup(layout, layout.activeGroupId, 'row', tab, measureGroupSizes());
    if (result.error === 'too-many-groups') toast(S.tabs.tooManyGroups);
    else if (result.error === 'too-small') toast(S.tabs.tooSmall);
    return result;
  });
}

function copy(text: string): void {
  navigator.clipboard.writeText(text).catch((error: unknown) => console.warn('[harnas] clipboard', error));
}

/** Отказ файлового API — английский текст по коду; `files:*` `errorText` не знает (E.1). */
function failureText(error: unknown, action: string): string {
  const { code } = decodeIpcError(error);
  return code === 'files:denied' ? S.files.denied : errorText(code, action);
}

interface RowProps {
  row: TreeRow;
  root: FileRoot;
  rootKey: string;
  rootDir: string | null;
  expanded: boolean;
  letter: GitStatusLetter | undefined;
  bridge: HarnasBridge;
  style?: React.CSSProperties;
}

const Row = memo(function Row({ row, root, rootKey, rootDir, expanded, letter, bridge, style }: RowProps): JSX.Element {
  const source: DragSourceData = { item: { kind: 'file', root, path: row.path } };
  const { setNodeRef, attributes, listeners } = useDraggable({ id: dndId.file(rootKey, row.path), data: source, disabled: !row.openable });
  // Симлинк без цели в корне (висячий или наружу) — не открывается и не раскрывается.
  const dead = !row.dir && !row.openable;
  const absPath = rootDir === null ? null : `${rootDir.endsWith('/') ? rootDir.slice(0, -1) : rootDir}/${row.path}`;

  const onClick = (event: React.MouseEvent): void => {
    if (row.dir) useFilesStore.getState().toggleDir(rootKey, row.path);
    else if (row.openable) openFile(root, row.path, event.metaKey);
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={setNodeRef}
          {...attributes}
          {...listeners}
          role="treeitem"
          data-tree-path={row.path}
          aria-expanded={row.dir ? expanded : undefined}
          aria-disabled={dead ? true : undefined}
          title={row.path}
          style={{ ...style, paddingLeft: 8 + row.depth * INDENT, height: ROW_HEIGHT }}
          className={cn(
            // Пилюля с заливкой hover `text 6 %`; вторичный текст (шеврон, буква git) на ней — основной цвет
            // (наследство куска 1: `--muted-foreground` на заливке ниже 4.5:1).
            'flex min-w-0 cursor-default select-none items-center gap-1.5 rounded-full pr-3 text-xs transition-colors hover:bg-foreground/6 hover:[--muted-foreground:var(--foreground)]',
            (row.entry.ignored || dead) && 'opacity-50',
          )}
          onClick={onClick}
        >
          <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
            {row.dir ? (
              expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />
            ) : row.entry.kind === 'symlink' ? (
              <Link2 className="size-3" />
            ) : (
              <FileIcon className="size-3" />
            )}
          </span>
          <span className="min-w-0 flex-1 truncate" style={letter === undefined ? undefined : { color: GIT_COLOR[letter] }}>
            {row.name}
          </span>
          {letter === undefined ? null : (
            <span data-git-status className="shrink-0 font-mono text-[11px] font-bold" style={{ color: GIT_COLOR[letter] }}>
              {letter}
            </span>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {row.openable ? (
          <>
            <ContextMenuItem onSelect={() => openFile(root, row.path, false)}>{S.sidebar.sessionMenu.open}</ContextMenuItem>
            <ContextMenuItem onSelect={() => openFile(root, row.path, true)}>{S.sidebar.sessionMenu.openBeside}</ContextMenuItem>
            <ContextMenuSeparator />
          </>
        ) : null}
        <ContextMenuItem
          disabled={absPath === null}
          onSelect={() => {
            if (absPath === null) return;
            bridge.app.showInFinder(absPath).catch((error: unknown) => {
              console.warn('[harnas] app.showInFinder', error);
              toast(failureText(error, S.errors.actions.revealInFinder));
            });
          }}
        >
          {S.cardMenu.reveal}
        </ContextMenuItem>
        <ContextMenuItem disabled={absPath === null} onSelect={() => absPath !== null && copy(absPath)}>
          {S.cardMenu.copyPath}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => copy(row.path)}>{S.files.copyRelativePath}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});

export interface TreeProps {
  bridge: HarnasBridge;
  root: FileRoot;
  /** Папка корня на диске — для «Reveal in Finder» и «Copy path»; null — корня в снимке нет. */
  rootDir: string | null;
  status: Readonly<Record<string, GitStatusLetter>>;
  showIgnored: boolean;
  /** Смена значения — перечитать все прочитанные папки (кнопка «Refresh»). */
  reloadToken: number;
  /** `files.list` корня ответил `not_found`: папки корня на диске больше нет. */
  onRootGone(): void;
}

export function Tree({ bridge, root, rootDir, status, showIgnored, reloadToken, onRootGone }: TreeProps): JSX.Element {
  const key = rootKeyOf(root);
  const expanded = useFilesStore((state) => state.expanded[key]) ?? EMPTY_SET;
  const [dirs, setDirs] = useState<Record<string, DirEntry[]>>({});
  // Папки в полёте — не состояние: повторный эффект до ответа не должен звать `list` второй раз.
  const loading = useRef(new Set<string>());
  const alive = useRef(true);
  const onRootGoneRef = useRef(onRootGone);
  onRootGoneRef.current = onRootGone;
  const rootRef = useRef(root);
  rootRef.current = root;

  // Событие пришло, пока папка в полёте: ответ мог устареть — перечитать ещё раз по его приходу.
  const again = useRef(new Set<string>());
  // Корень не прочитался: реестр корней main мог ещё не узнать новый worktree — повтор на works.changed.
  const rootFailed = useRef(false);

  const load = useRef((dir: string): void => {
    if (loading.current.has(dir)) {
      again.current.add(dir);
      return;
    }
    loading.current.add(dir);
    bridge.files
      .list(rootRef.current, dir)
      .then((entries) => {
        if (dir === '') rootFailed.current = false;
        if (alive.current) setDirs((current) => ({ ...current, [dir]: entries }));
      })
      .catch((error: unknown) => {
        if (!alive.current) return;
        console.warn('[harnas] files.list', error);
        const { code } = decodeIpcError(error);
        // Пустая папка вместо ошибки — иначе эффект ниже звал бы `list` на каждую отрисовку.
        setDirs((current) => ({ ...current, [dir]: [] }));
        if (dir === '' && code === 'not_found') {
          onRootGoneRef.current();
          return;
        }
        if (dir === '') rootFailed.current = true;
        toast(failureText(error, S.errors.actions.readFolder));
      })
      .finally(() => {
        loading.current.delete(dir);
        if (again.current.delete(dir) && alive.current) load(dir);
      });
  }).current;

  useEffect(
    () =>
      bridge.on('works.changed', () => {
        if (rootFailed.current) load('');
      }),
    [bridge, load],
  );

  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  const rows = useMemo(() => flattenTree(dirs, expanded, showIgnored), [dirs, expanded, showIgnored]);

  // Нужные папки: корень и раскрытые, чьи предки тоже раскрыты, — только они и читаются.
  useEffect(() => {
    if (dirs[''] === undefined) load('');
    for (const row of rows) {
      if (row.dir && expanded.has(row.path) && dirs[row.path] === undefined) load(row.path);
    }
  }, [dirs, rows, expanded, load]);

  // Событие слежения: раскрытые папки перечитываются сразу, свёрнутые выпадают из кэша —
  // следующее раскрытие прочтёт их заново.
  useEffect(
    () =>
      bridge.files.onTreeChanged((event) => {
        if (event.rootKey !== key) return;
        const open = useFilesStore.getState().expanded[key] ?? EMPTY_SET;
        const stale: string[] = [];
        for (const dir of event.dirs) {
          if (dir === '' || open.has(dir)) load(dir);
          else stale.push(dir);
        }
        if (stale.length > 0) {
          setDirs((current) => {
            if (!stale.some((dir) => dir in current)) return current;
            const next = { ...current };
            for (const dir of stale) delete next[dir];
            return next;
          });
        }
      }),
    [bridge, key, load],
  );

  // «Refresh» — перечитать всё прочитанное; первая отрисовка (0) ничего не делает.
  const dirsRef = useRef(dirs);
  dirsRef.current = dirs;
  useEffect(() => {
    if (reloadToken === 0) return;
    for (const dir of Object.keys(dirsRef.current)) load(dir);
  }, [reloadToken, load]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const renderRow = (row: TreeRow, style?: React.CSSProperties): JSX.Element => (
    <Row
      key={row.path}
      row={row}
      root={root}
      rootKey={key}
      rootDir={rootDir}
      expanded={row.dir && expanded.has(row.path)}
      letter={status[row.path]}
      bridge={bridge}
      {...(style === undefined ? {} : { style })}
    />
  );

  return (
    <div ref={scrollRef} data-tree-scroll role="tree" className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-1">
      {rows.length > VIRTUAL_AFTER ? (
        <VirtualRows scrollRef={scrollRef} rows={rows} renderRow={renderRow} />
      ) : (
        rows.map((row) => renderRow(row))
      )}
    </div>
  );
}

interface VirtualRowsProps {
  scrollRef: React.RefObject<HTMLDivElement>;
  rows: TreeRow[];
  renderRow(row: TreeRow, style: React.CSSProperties): JSX.Element;
}

/** Строки фиксированной высоты: в DOM — видимые и запас по краям. */
function VirtualRows({ scrollRef, rows, renderRow }: VirtualRowsProps): JSX.Element {
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (index) => rows[index]?.path ?? index,
    overscan: 10,
  });
  return (
    <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((item) => {
        const row = rows[item.index];
        if (row === undefined) return null;
        return renderRow(row, { position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${item.start}px)` });
      })}
    </div>
  );
}
