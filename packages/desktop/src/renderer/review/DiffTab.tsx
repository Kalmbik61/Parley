/**
 * Тело вкладки диффа (кусок 8.3, спека 11.3): список файлов сверху, под ним — секция с Monaco
 * `DiffEditor` на каждый файл. Заменяет прежние панели этапа 4 (`ChangesPanel.tsx` и `DiffView.tsx`).
 *
 * - Режим ветки — файлы `useChanges({ mergeCheck: false })` (8.2a): те же сигналы обновления, что у
 *   вкладки «Изменения» (решение сверки I7); каждая загрузка — новый `source`, по нему живые
 *   редакторы перечитывают стороны. Режим коммита — `files.gitCommitFiles`: коммит неизменен.
 * - Корень — worktree сессии, иначе папка проекта (стороны `HEAD` ↔ диск).
 * - Хост старее окна (без `worktrees.mergeCheck`) — кнопка перезапуска и ни одного вызова, как у
 *   «Изменений» (8.2b): старый `worktrees.diff` отвечает без `mergeBase`.
 * - Сбой Monaco — своя граница `S.files.editorFailed` с «Retry»; «Open in default app» здесь нет:
 *   файлов во вкладке много.
 * - Заметки (8.4b, спека 11.4) — только в режиме ветки: открытие вкладки грузит заметки сессии
 *   (стор читает файл один раз на удачу, после отказа — снова), секции ставят и показывают их,
 *   «Send all unsent» панели шлёт неотправленные неустаревшие заметки файлов вкладки. Отправка —
 *   `sendDeps` окна (7.2) и только по нажатию человека (рамка 15.1).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DiffNote } from '../../shared/notes-types.js';
import type { WorkEntry } from '@harnas/core';
import { refKey } from '@harnas/protocol';
import type { HarnasBridge } from '../../shared/bridge.js';
import type { DiffFile, FileRoot } from '../../shared/files-types.js';
import { decodeIpcError } from '../../shared/ipc-error.js';
import type { TabSpec } from '../../shared/layout-types.js';
import { errorText, S } from '../../shared/strings.js';
import { bufferKey } from '../files/buffer.js';
import { useMonacoReady } from '../files/editor/MonacoEditor.js';
import { setupMonaco } from '../files/editor/monaco-setup.js';
import { useHostSupports } from '../lib/capabilities.js';
import { ErrorBoundary } from '../shell/ErrorBoundary.js';
import { useHostStore } from '../store/host.js';
import { useUiStore } from '../store/ui.js';
import type { SendWithToastDeps } from '../terminal/send.js';
import { Button } from '../ui/button.js';
import { DIFF_LIMITS } from './diff-sides.js';
import { DiffToolbar, type DiffListMode } from './DiffToolbar.js';
import { FileDiffSection, type DiffMode, type SectionNotes } from './FileDiffSection.js';
import { batchable, sendNotes } from './notes/send-notes.js';
import { notesKey, useNotesStore } from './notes/store.js';
import { useReviewStore } from './store.js';
import { useChanges } from './use-changes.js';

export interface DiffTabProps {
  bridge: HarnasBridge;
  workKey: string;
  entry: WorkEntry;
  tab: Extract<TabSpec, { kind: 'diff' }>;
  /** Шрифт редактора из настроек, как у вкладки файла; сверх брифа — без него Monaco берёт свой. */
  font?: { family: string; size: number };
  /** Отправка агенту окна (7.2): AppShell → LayoutView → LayoutBodyContext → DiffBody (8.4b). */
  sendDeps: SendWithToastDeps;
}

const FILE_STATUS: Record<string, string> = S.changes.fileStatus;

function Centered({ children }: { children: string }): JSX.Element {
  return <div className="flex h-full items-center justify-center p-4 text-center text-sm text-muted-foreground">{children}</div>;
}

/** Файлы коммита: один вызов на коммит — коммит неизменен, сигналы обновления его не трогают. */
function useCommitFiles(
  files: HarnasBridge['files'],
  root: FileRoot,
  hash: string | null,
): { files: DiffFile[] | null; error: string | null } {
  const [state, setState] = useState<{ hash: string; files: DiffFile[] | null; error: string | null } | null>(null);
  const rootRef = useRef(root);
  rootRef.current = root;
  const rootId = `${root.workKey}\n${JSON.stringify(root.spec)}`;
  useEffect(() => {
    if (hash === null) return undefined;
    let alive = true;
    setState({ hash, files: null, error: null });
    files.gitCommitFiles(rootRef.current, hash).then(
      (list) => {
        if (alive) setState({ hash, files: list, error: null });
      },
      (error: unknown) => {
        const info = decodeIpcError(error);
        console.warn('[harnas] diff: gitCommitFiles', info.code, info.message);
        if (alive) setState({ hash, files: null, error: errorText(info.code, S.errors.actions.loadDiff) });
      },
    );
    return () => {
      alive = false;
    };
  }, [files, rootId, hash]);
  if (hash === null || state === null || state.hash !== hash) return { files: null, error: null };
  return { files: state.files, error: state.error };
}

type Row = { kind: 'dir'; key: string; name: string; depth: number } | { kind: 'file'; file: DiffFile; name: string; depth: number };

/** Дерево без сворачивания: строка папки — на каждый новый каталог пути, файлы — под ним с отступом. */
function treeRows(files: DiffFile[]): Row[] {
  const rows: Row[] = [];
  let previous: string[] = [];
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const parts = file.path.split('/');
    const dirs = parts.slice(0, -1);
    let common = 0;
    while (common < dirs.length && common < previous.length && dirs[common] === previous[common]) common += 1;
    for (let depth = common; depth < dirs.length; depth += 1) {
      rows.push({ kind: 'dir', key: dirs.slice(0, depth + 1).join('/'), name: dirs[depth] ?? '', depth });
    }
    rows.push({ kind: 'file', file, name: parts[parts.length - 1] ?? file.path, depth: dirs.length });
    previous = dirs;
  }
  return rows;
}

/**
 * Секций за раз (раунд fix-final-c, п. 1): тысячи неотслеживаемых давали тысячи секций с
 * наблюдателем на каждую. Дальше — «Show N more»; переход к файлу за пределом дорисовывает до него.
 */
const SECTION_STEP = 100;

function FileList({ files, mode, onOpen }: { files: DiffFile[]; mode: DiffListMode; onOpen(path: string): void }): JSX.Element {
  const rows: Row[] = mode === 'tree' ? treeRows(files) : files.map((file) => ({ kind: 'file', file, name: file.path, depth: 0 }));
  return (
    <ul data-testid="diff-file-list" className="max-h-[30%] shrink-0 overflow-y-auto border-b border-border py-1">
      {rows.map((row) =>
        row.kind === 'dir' ? (
          <li
            key={`d:${row.key}`}
            className="flex h-6 min-w-0 items-center px-3 text-xs text-muted-foreground"
            style={{ paddingLeft: 12 + row.depth * 12 }}
            title={row.key}
          >
            <span className="truncate">{row.name}</span>
          </li>
        ) : (
          <li key={`f:${row.file.path}`} className="min-w-0">
            <button
              type="button"
              title={row.file.oldPath === null ? row.file.path : `${row.file.oldPath} → ${row.file.path}`}
              className="flex h-6 w-full min-w-0 items-center gap-2 px-3 text-left text-xs hover:bg-accent"
              style={{ paddingLeft: 12 + row.depth * 12 }}
              onClick={() => onOpen(row.file.path)}
            >
              <span className="w-3 shrink-0 font-mono text-muted-foreground" title={FILE_STATUS[row.file.status] ?? row.file.status}>
                {row.file.status}
              </span>
              <span className="min-w-0 flex-1 truncate">{row.name}</span>
              {row.file.additions === null ? null : <span className="shrink-0 tabular-nums text-status-success-text">{`+${row.file.additions}`}</span>}
              {row.file.deletions === null ? null : <span className="shrink-0 tabular-nums text-destructive">{`−${row.file.deletions}`}</span>}
            </button>
          </li>
        ),
      )}
    </ul>
  );
}

/** Язык модели по имени файла: `@monaco-editor/react` без него берёт `text` — без подсветки. */
function languageOf(monaco: ReturnType<typeof setupMonaco>, path: string): string | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  for (const language of monaco.languages.getLanguages()) {
    if (language.filenames?.some((candidate) => candidate.toLowerCase() === name)) return language.id;
    if (language.extensions?.some((extension) => name.endsWith(extension.toLowerCase()))) return language.id;
  }
  return undefined;
}

/**
 * Живой, который освобождается первым: дальше всех от секций в экране. Экрана ещё нет (переход
 * к файлу до первого пересечения) — от впускаемой секции. Ушедший из списка — первым.
 */
function farthest(live: string[], keep: string, index: Map<string, number>, visible: Set<string>): string | undefined {
  const anchors = [...(visible.size > 0 ? visible : [keep])].map((path) => index.get(path)).filter((i): i is number => i !== undefined);
  let worst: string | undefined;
  let worstDistance = -1;
  for (const path of live) {
    if (path === keep) continue;
    const at = index.get(path);
    const distance = at === undefined ? Infinity : Math.min(Infinity, ...anchors.map((anchor) => Math.abs(anchor - at)));
    if (distance > worstDistance) {
      worst = path;
      worstDistance = distance;
    }
  }
  return worst;
}

/**
 * Удержание цели перехода (раунд fix-8b, пункт 1): после `scrollIntoView` секции над целью
 * домонтируются — заглушка оценочной высоты сменяется живым редактором, — раскладка сдвигается, и
 * цель уезжает из экрана (замер на 35 файлах: scrollTop 10023 → 9655 без участия человека).
 * Пока высоты не осели (секунда без изменений), каждое изменение размера секции снова ставит цель
 * к верхнему краю. Выбрано вместо точной оценки заглушки: высоту живого редактора (скрытые
 * неизменённые строки, перенос, шрифт) до монтирования не узнать.
 */
const SETTLE_MS = 1000;
/** Прокрутка человека — колесо, касание, мышь (ползунок) или клавиши — снимает удержание сразу. */
const USER_SCROLL = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

interface DiffViewProps {
  bridge: HarnasBridge;
  workKey: string;
  tabId: string;
  root: FileRoot;
  files: DiffFile[];
  mode: DiffMode;
  version: unknown;
  font: DiffTabProps['font'];
  notes: SectionNotes | null;
}

/** Неотправленные неустаревшие заметки файлов вкладки: заметки ушедших из диффа файлов не видны — и не шлются. */
function useUnsent(notes: SectionNotes | null, files: DiffFile[]): DiffNote[] {
  const all = useNotesStore((state) => (notes === null ? undefined : state.bySession[notesKey(notes.workKey, notes.sessionId)]));
  return useMemo(() => {
    const paths = new Set(files.map((file) => file.path));
    return batchable(all ?? []).filter((note) => paths.has(note.path));
  }, [all, files]);
}

function DiffView({ bridge, workKey, tabId, root, files, mode, version, font, notes }: DiffViewProps): JSX.Element {
  const status = useMonacoReady();
  const view = useUiStore((state) => state.ui.diffView);
  const dark = useUiStore((state) => state.dark);
  const [wrap, setWrap] = useState(false);
  const [listMode, setListMode] = useState<DiffListMode>('list');
  const [collapsed, setCollapsed] = useState<Record<string, true>>({});
  const [live, setLive] = useState<string[]>([]);
  const [shown, setShown] = useState(SECTION_STEP);
  const visible = useRef(new Set<string>());
  const elements = useRef(new Map<string, HTMLElement>());
  const io = useRef<IntersectionObserver | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const index = useMemo(() => new Map(files.map((file, i) => [file.path, i])), [files]);
  const indexRef = useRef(index);
  indexRef.current = index;
  const ready = status === 'ready';
  const unsent = useUnsent(notes, files);
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;

  const admit = useCallback((path: string) => {
    setLive((current) => {
      if (current.includes(path)) return current;
      const next = [...current, path];
      while (next.length > DIFF_LIMITS.maxEditors) {
        const out = farthest(next, path, indexRef.current, visible.current);
        if (out === undefined) break;
        next.splice(next.indexOf(out), 1);
      }
      return next;
    });
  }, []);

  const register = useCallback((path: string, element: HTMLElement | null) => {
    const previous = elements.current.get(path);
    if (previous !== undefined && previous !== element) io.current?.unobserve(previous);
    if (element === null) {
      elements.current.delete(path);
      return;
    }
    elements.current.set(path, element);
    io.current?.observe(element);
  }, []);

  useEffect(() => {
    if (!ready) return undefined;
    // Редактор монтируется за 400px до экрана (таблица чисел плана): прокрутка не видит пустых секций.
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const path = entry.target.getAttribute('data-diff-path');
          if (path === null) continue;
          if (entry.isIntersecting) {
            visible.current.add(path);
            // Свёрнутая секция слот живого редактора не занимает (раунд 8, пункт 6): иначе вытеснила бы
            // видимый развёрнутый файл, ничего не показав. Наблюдение не снимаем — видимость нужна
            // «Expand», чтобы сразу выдать слот; проверка здесь, а не в admit: reveal и Expand зовут
            // admit раньше, чем collapsedRef увидит разворот.
            if (!(path in collapsedRef.current)) admit(path);
          } else {
            visible.current.delete(path);
          }
        }
      },
      { root: scroller.current, rootMargin: '400px' },
    );
    io.current = observer;
    for (const element of elements.current.values()) observer.observe(element);
    return () => {
      observer.disconnect();
      io.current = null;
    };
  }, [ready, admit]);

  // Файл ушёл из списка — его секции и редактора больше нет.
  useEffect(() => {
    setLive((current) => (current.every((path) => index.has(path)) ? current : current.filter((path) => index.has(path))));
    for (const path of [...visible.current]) if (!index.has(path)) visible.current.delete(path);
  }, [index]);

  const release = useRef<(() => void) | null>(null);

  const hold = useCallback((path: string) => {
    release.current?.();
    const node = scroller.current;
    // Без ResizeObserver (jsdom) — только первая прокрутка, как раньше.
    if (node === null || typeof ResizeObserver === 'undefined') return;
    const align = (): void => {
      const target = elements.current.get(path);
      if (target === undefined) return;
      const delta = target.getBoundingClientRect().top - node.getBoundingClientRect().top;
      // У последних файлов выше края не встать: браузер зажмёт scrollTop сам.
      if (Math.abs(delta) >= 1) node.scrollTop += delta;
    };
    let timer = setTimeout(stop, SETTLE_MS);
    const observer = new ResizeObserver(() => {
      align();
      clearTimeout(timer);
      timer = setTimeout(stop, SETTLE_MS);
    });
    for (const element of elements.current.values()) observer.observe(element);
    function stop(): void {
      clearTimeout(timer);
      observer.disconnect();
      if (release.current === stop) release.current = null;
    }
    release.current = stop;
  }, []);

  useEffect(() => {
    const node = scroller.current;
    if (!ready || node === null) return undefined;
    const onUser = (): void => release.current?.();
    for (const type of USER_SCROLL) node.addEventListener(type, onUser, { capture: true, passive: true });
    return () => {
      for (const type of USER_SCROLL) node.removeEventListener(type, onUser, { capture: true });
      release.current?.();
    };
  }, [ready]);

  const revealed = useReviewStore((state) => state.revealed[bufferKey(workKey, tabId)]);
  const handled = useRef(0);
  useEffect(() => {
    if (!ready || revealed === undefined || revealed.nonce === handled.current || !index.has(revealed.path)) return;
    const path = revealed.path;
    // Файл за пределом секций: сначала дорисовать до него (шагами предела), переход — на следующем
    // проходе эффекта, когда секция уже в DOM.
    const at = index.get(path) ?? 0;
    if (at >= shown) {
      setShown(Math.ceil((at + 1) / SECTION_STEP) * SECTION_STEP);
      return;
    }
    handled.current = revealed.nonce;
    setCollapsed((current) => {
      if (!(path in current)) return current;
      const next = { ...current };
      delete next[path];
      return next;
    });
    admit(path);
    elements.current.get(path)?.scrollIntoView({ block: 'start' });
    hold(path);
  }, [ready, revealed, index, admit, hold, shown]);

  const onToggle = useCallback(
    (path: string) => {
      if (path in collapsedRef.current) {
        setCollapsed((current) => {
          const next = { ...current };
          delete next[path];
          return next;
        });
        if (visible.current.has(path)) admit(path);
        return;
      }
      setCollapsed((current) => ({ ...current, [path]: true }));
      // Свёрнутая секция места среди живых не держит.
      setLive((list) => list.filter((candidate) => candidate !== path));
    },
    [admit],
  );

  const options = useMemo(
    () => ({
      readOnly: true,
      originalEditable: false,
      renderSideBySide: view === 'split',
      // Раунд fix-live, D1: уже 900 px Monaco по умолчанию сам сводит «Side by side» в одну колонку,
      // и переключатель выглядит сломанным. Выбор человека соблюдается при любой ширине.
      useInlineViewWhenSpaceIsLimited: false,
      hideUnchangedRegions: { enabled: true, contextLineCount: 3 },
      wordWrap: wrap ? 'on' : 'off',
      diffWordWrap: wrap ? 'on' : 'off',
      minimap: { enabled: false },
      renderOverviewRuler: false,
      scrollBeyondLastLine: false,
      automaticLayout: true,
      // Колесо над редактором, которому некуда крутить, листает вкладку, а не застревает.
      scrollbar: { alwaysConsumeMouseWheel: false },
      ...(font === undefined ? {} : { fontFamily: font.family, fontSize: Math.max(1, font.size - 1) }),
    }),
    [view, wrap, font?.family, font?.size],
  );

  const languages = useMemo(() => {
    if (!ready) return new Map<string, string | undefined>();
    const monaco = setupMonaco();
    return new Map(files.map((file) => [file.path, languageOf(monaco, file.path)]));
  }, [ready, files]);

  if (status instanceof Error) throw status;
  if (!ready) return <Centered>{S.changes.loading}</Centered>;

  const theme = dark ? 'harnas-dark' : 'harnas-light';
  return (
    <div data-testid="diff-tab" className="flex h-full min-h-0 flex-col">
      <DiffToolbar
        view={view}
        onView={(next) => useUiStore.getState().patchUi({ diffView: next })}
        wrap={wrap}
        onWrap={setWrap}
        onCollapseAll={() => {
          setCollapsed(Object.fromEntries(files.map((file) => [file.path, true as const])));
          setLive([]);
        }}
        onExpandAll={() => {
          setCollapsed({});
          for (const file of files) if (visible.current.has(file.path)) admit(file.path);
        }}
        listMode={listMode}
        onListMode={setListMode}
        sendAll={
          notes === null
            ? null
            : { entry: notes.entry, defaultSessionId: notes.sessionId, disabled: unsent.length === 0, onSend: (to) => notes.send(unsent, to) }
        }
      />
      <FileList files={files} mode={listMode} onOpen={(path) => useReviewStore.getState().revealFile(workKey, tabId, path)} />
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        {files.slice(0, shown).map((file) => (
          <FileDiffSection
            key={file.path}
            file={file}
            files={bridge.files}
            root={root}
            mode={mode}
            version={version}
            live={live.includes(file.path)}
            collapsed={file.path in collapsed}
            onToggle={onToggle}
            options={options}
            split={view === 'split'}
            theme={theme}
            language={languages.get(file.path)}
            register={register}
            notes={notes}
          />
        ))}
        {files.length > shown ? (
          <div className="flex justify-center p-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setShown((current) => current + SECTION_STEP)}>
              {S.changes.showMore(Math.min(SECTION_STEP, files.length - shown))}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function DiffTab({ bridge, workKey, entry, tab, font, sendDeps }: DiffTabProps): JSX.Element {
  const supported = useHostSupports('worktrees.mergeCheck');
  const connected = useHostStore((state) => state.status.state === 'connected');
  const sessionId = tab.sessionId;
  const session = entry.map.sessions.find((candidate) => candidate.id === sessionId);
  const worktree = session?.worktree ?? null;
  const pending = worktree !== null && worktree.createdAt === null;
  const key = refKey({ projectPath: entry.projectPath, workId: entry.map.work.id, sessionId });
  const discarded = useReviewStore((state) => state.discarded[key] === true);
  // Старый хост, нет worktree на диске или он отброшен — загрузки нет вовсе.
  const loadable = supported && !pending && !discarded;
  const commit = tab.commit;
  const changes = useChanges({ bridge, entry, sessionId: loadable && commit === null ? sessionId : null, mergeCheck: false });
  const hasWorktree = worktree !== null;
  const root = useMemo<FileRoot>(
    () => ({ workKey, spec: hasWorktree ? { kind: 'worktree', sessionId } : { kind: 'project' } }),
    [workKey, hasWorktree, sessionId],
  );
  const commitFiles = useCommitFiles(bridge.files, root, loadable ? commit : null);

  // Каждое открытие вкладки диффа ветки — load: удачное чтение стор помнит и мост второй раз не
  // зовёт, отказ забывает — следующее открытие прочитает снова (fix-8.4a). Коммиту заметки не нужны.
  useEffect(() => {
    if (commit === null) void useNotesStore.getState().load(bridge, workKey, sessionId);
  }, [bridge, workKey, sessionId, commit]);

  const branch = worktree?.branch ?? (changes.source?.kind === 'project' ? changes.source.changes.branch : null);
  const notes = useMemo<SectionNotes | null>(
    () =>
      commit !== null
        ? null
        : {
            workKey,
            sessionId,
            entry,
            send: (list, to) =>
              sendNotes({ deps: sendDeps, projectPath: entry.projectPath, workId: entry.map.work.id, workKey, sessionId, branch, notes: list, to }),
          },
    [commit, workKey, sessionId, entry, sendDeps, branch],
  );

  const source = changes.source;
  const base = source?.kind === 'worktree' ? source.diff.mergeBase : source?.kind === 'project' ? 'HEAD' : null;
  const mode = useMemo<DiffMode | null>(
    () => (commit !== null ? { kind: 'commit', hash: commit } : base === null ? null : { kind: 'branch', base }),
    [commit, base],
  );

  if (connected && !supported) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <Button type="button" variant="outline" size="sm" onClick={() => useUiStore.getState().confirmRestartHost()}>
          {S.statusBar.hostOutdated}
        </Button>
      </div>
    );
  }
  if (pending) return <Centered>{S.changes.worktreePending}</Centered>;
  if (discarded) return <Centered>{S.changes.worktreeDiscarded}</Centered>;

  let files: DiffFile[] | null;
  let version: unknown;
  let error: string | null;
  if (commit !== null) {
    files = commitFiles.files;
    version = commitFiles.files;
    error = commitFiles.error;
  } else {
    files = source?.kind === 'worktree' ? source.diff.files : source?.kind === 'project' ? source.changes.files : null;
    version = source;
    error = changes.error;
  }
  if (error !== null) return <Centered>{error}</Centered>;
  if (files === null || mode === null) return <Centered>{S.changes.loading}</Centered>;
  if (files.length === 0) return <Centered>{S.changes.noChanges}</Centered>;

  return (
    <div className="h-full min-h-0">
      <ErrorBoundary title={S.files.editorFailed}>
        <DiffView bridge={bridge} workKey={workKey} tabId={tab.id} root={root} files={files} mode={mode} version={version} font={font} notes={notes} />
      </ErrorBoundary>
    </div>
  );
}
