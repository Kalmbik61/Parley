/**
 * Вкладка «Файлы» правого сайдбара (кусок 7.2, спека 10.1, 13): шапка с выбором корня,
 * «Refresh» при отказе слежения и переключателем игнорируемых; ниже — дерево корня.
 *
 * Корень — `filesRootSpec`: выбор человека, пока его нет — worktree сессии в фокусе
 * (`focusedSessionOf`). Панель следит за корнем (`files.watch(root, '')`) и держит его
 * `gitStatus`: перечитывается не чаще раза в 2 с — по `treeChanged`, `works.changed`, концу хода
 * сессии корня и при показе панели. Коммит агента файлов дерева не меняет, а `.git/` слежение
 * пропускает (у worktree каталог git и вовсе вне корня): без этих поводов буквы висели бы до
 * следующей правки.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Eye, EyeOff, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import type { WorkEntry } from '@harnas/core';
import { refKey } from '@harnas/protocol';
import type { HarnasBridge } from '../../shared/bridge.js';
import type { FileRoot, GitStatusLetter } from '../../shared/files-types.js';
import { decodeIpcError } from '../../shared/ipc-error.js';
import type { FileRootSpec } from '../../shared/layout-types.js';
import { S } from '../../shared/strings.js';
import { rootKey as rootKeyOf } from '../../shared/work-keys.js';
import { focusedSessionOf, useLayoutStore } from '../layout/store.js';
import { workKey as workKeyOf } from '../lib/tree-order.js';
import { useActivityStore, type ActivityEntry } from '../store/activity.js';
import { useUiStore } from '../store/ui.js';
import { Button } from '../ui/button.js';
import { retryWhileDenied } from './retry.js';
import { RootPicker } from './RootPicker.js';
import { filesRootSpec, rootDirOf, useFilesStore } from './store.js';
import { Tree } from './Tree.js';

/** `gitStatus` — не чаще раза в 2 с (спека 10.1). */
export const GIT_STATUS_INTERVAL_MS = 2000;

type Status = Readonly<Record<string, GitStatusLetter>>;
const NO_STATUS: Status = {};

/**
 * Статус корня с дросселем: первый повод — сразу, следующие в пределах 2 с — одним вызовом в
 * конце окна. `refresh(true)` — «Refresh» человека: сразу, мимо дросселя.
 */
function useGitStatus(bridge: HarnasBridge, root: FileRoot): { status: Status; refresh(now?: boolean): void } {
  const [status, setStatus] = useState<Status>(NO_STATUS);
  const request = useRef<(now?: boolean) => void>(() => {});
  const key = rootKeyOf(root);
  const rootRef = useRef(root);
  rootRef.current = root;

  useEffect(() => {
    let disposed = false;
    let last = Number.NEGATIVE_INFINITY;
    let timer: ReturnType<typeof setTimeout> | null = null;
    setStatus(NO_STATUS);
    const run = (): void => {
      timer = null;
      last = Date.now();
      retryWhileDenied(() => bridge.files.gitStatus(rootRef.current), () => !disposed)
        .then((next) => {
          if (!disposed) setStatus(next);
        })
        .catch((error: unknown) => console.warn('[harnas] files.gitStatus', error));
    };
    request.current = (now = false) => {
      if (disposed) return;
      if (now) {
        if (timer !== null) clearTimeout(timer);
        run();
        return;
      }
      if (timer !== null) return;
      const wait = last + GIT_STATUS_INTERVAL_MS - Date.now();
      if (wait <= 0) run();
      else timer = setTimeout(run, wait);
    };
    // Показ панели и новый корень — первый повод.
    request.current();
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [bridge, key]);

  const refresh = useCallback((now?: boolean) => request.current(now), []);
  return { status, refresh };
}

/** Сессии, чья папка — этот корень: worktree — его сессия, проект — сессии работы без своего worktree. */
function rootSessions(entry: WorkEntry, spec: FileRootSpec): string[] {
  if (spec.kind === 'worktree') return [spec.sessionId];
  return entry.map.sessions.filter((session) => session.worktree === null || session.worktree.createdAt === null).map((session) => session.id);
}

/**
 * Конец хода: из `working` в любое другое или переход в `idle`. Спека называет переход в `idle`;
 * законченный, но не просмотренный ход — `unseen`, а коммит агент делает именно в конце хода.
 */
function turnEnded(prev: ActivityEntry | undefined, next: ActivityEntry | undefined): boolean {
  if (next === undefined || prev === next) return false;
  const was = prev?.activity.activity;
  const now = next.activity.activity;
  return (was === 'working' && now !== 'working') || (now === 'idle' && was !== 'idle');
}

export interface FilesPanelProps {
  bridge: HarnasBridge;
  entry: WorkEntry;
}

export function FilesPanel({ bridge, entry }: FilesPanelProps): JSX.Element {
  const workKey = workKeyOf(entry.projectPath, entry.map.work.id);
  const focused = useLayoutStore((state) => focusedSessionOf(state, workKey));
  const chosen = useFilesStore((state) => state.rootByWork[workKey]);
  const spec = filesRootSpec(chosen === undefined ? {} : { [workKey]: chosen }, entry, focused);
  const specKey = spec.kind === 'project' ? 'project' : spec.sessionId;
  // Одна ссылка на корень, пока он тот же (зависимость — ключ `spec`, а не новый объект на
  // каждую отрисовку): дерево и подписки ниже зависят от неё.
  const root = useMemo<FileRoot>(() => ({ workKey, spec }), [workKey, specKey]);
  const key = rootKeyOf(root);
  const rootDir = rootDirOf(entry, spec);
  const showIgnored = useUiStore((state) => state.ui.filesShowIgnored);
  const patchUi = useUiStore((state) => state.patchUi);
  const [watchFailed, setWatchFailed] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const { status, refresh } = useGitStatus(bridge, root);

  // Корень исчез (worktree удалён) — сказать и перейти на проект; выбор человека тоже меняется.
  const rootGone = useCallback(() => {
    toast(S.files.rootGone);
    useFilesStore.getState().setRoot(workKey, { kind: 'project' });
  }, [workKey]);
  useEffect(() => {
    if (spec.kind === 'worktree' && rootDirOf(entry, spec) === null) rootGone();
  }, [entry, spec, rootGone]);

  // Слежение за деревом корня. Отказ — «Refresh» в шапке (спека 13).
  useEffect(() => {
    if (rootDir === null) return undefined;
    let disposed = false;
    let id: string | null = null;
    setWatchFailed(false);
    retryWhileDenied(() => bridge.files.watch(root, ''), () => !disposed)
      .then((got) => {
        if (disposed) void bridge.files.unwatch(got).catch(() => {});
        else id = got;
      })
      .catch((error: unknown) => {
        console.warn('[harnas] files.watch', error);
        if (!disposed && decodeIpcError(error).code === 'files:watch-failed') setWatchFailed(true);
      });
    return () => {
      disposed = true;
      if (id !== null) void bridge.files.unwatch(id).catch(() => {});
    };
    // Папка корня появилась или пропала — подписаться заново; сам путь в подписку не входит.
  }, [bridge, root, rootDir === null]);

  // Поводы перечитать статус: пачка слежения этого корня и снимок работ.
  useEffect(() => {
    const offTree = bridge.files.onTreeChanged((event) => {
      if (event.rootKey === key) refresh();
    });
    const offWorks = bridge.on('works.changed', () => refresh());
    return () => {
      offTree();
      offWorks();
    };
  }, [bridge, key, refresh]);

  // Конец хода сессии, чья папка — этот корень.
  const entryRef = useRef(entry);
  entryRef.current = entry;
  useEffect(
    () =>
      useActivityStore.subscribe((state, prev) => {
        if (state.byRef === prev.byRef) return;
        const current = entryRef.current;
        for (const sessionId of rootSessions(current, spec)) {
          const ref = refKey({ projectPath: current.projectPath, workId: current.map.work.id, sessionId });
          if (turnEnded(prev.byRef[ref], state.byRef[ref])) {
            refresh();
            return;
          }
        }
      }),
    // `spec` — тот же, пока тот же ключ корня.
    [key, refresh],
  );

  return (
    <div data-testid="files-panel" className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
        <RootPicker entry={entry} value={spec} onChange={(next) => useFilesStore.getState().setRoot(workKey, next)} />
        {watchFailed ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={S.files.refresh}
            title={S.files.refresh}
            onClick={() => {
              setReloadToken((token) => token + 1);
              refresh(true);
            }}
          >
            <RefreshCw className="size-3.5" />
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={S.files.showIgnored}
          title={S.files.showIgnored}
          aria-pressed={showIgnored}
          onClick={() => patchUi({ filesShowIgnored: !showIgnored })}
        >
          {showIgnored ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
        </Button>
      </div>
      <Tree
        key={key}
        bridge={bridge}
        root={root}
        rootDir={rootDir}
        status={status}
        showIgnored={showIgnored}
        reloadToken={reloadToken}
        onRootGone={spec.kind === 'worktree' ? rootGone : () => {}}
      />
    </div>
  );
}
