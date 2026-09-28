/**
 * Поверхность терминала в слое работы (кусок 2.5, спека 5.5, 5.10): xterm
 * живёт не в теле группы, а в `layout/SurfaceLayer.tsx` и привязан к телу своей
 * группы CSS-якорем `--g-<groupId>`. Перенос вкладки меняет только
 * `position-anchor` — xterm не пересоздаётся и PTY не переподключается.
 *
 * Корень несёт привязку, видимость, `data-tab-id`/`data-mount-id` и фон; всё
 * остальное (xterm, `use-terminal`, полоса поиска, запись в `terminalSurfaces`)
 * — во внутреннем компоненте под `ErrorBoundary`: граница ловит ошибки только
 * потомков, а запасной вид должен встать на место терминала внутри корня,
 * не заводя в слое лишнего containing block.
 *
 * Отличия от образца `components/terminal/TerminalPanel.tsx`: фон обёртки
 * отступа — фон темы xterm (иначе в тёмной теме вокруг терминала видна рамка
 * `--card`); на меню `find` поверхность сама не подписывается — смонтированы
 * все вкладки трёх работ, и ⌘F открыл бы полосу во всех; полосу открывает
 * `openSearch()` ручки, его зовёт `AppShell`.
 *
 * Кусок 2.6 (спека 5.4): корень — droppable `terminal` с `sessionId`, только
 * пока поверхность видима: скрытые терминалы группы лежат на месте видимого,
 * и бросок ушёл бы в чужую вкладку. В этапе 2 терминал ничего не принимает
 * (`acceptsTerminal`) — зона оживёт с файлами в 7.2. `z-index` у корня нет:
 * индикатор тела группы (`DropIndicator`, `z-index` 10) должен лечь поверх.
 */

import '@xterm/xterm/css/xterm.css';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { SearchAddon } from '@xterm/addon-search';
import { useDroppable } from '@dnd-kit/core';
import { toast } from 'sonner';
import type { WorkSession } from '@harnas/core';
import { refKey, type SessionRef } from '@harnas/protocol';
import type { HarnasBridge } from '../../shared/bridge.js';
import { decodeIpcError } from '../../shared/ipc-error.js';
import type { TabSpec } from '../../shared/layout-types.js';
import { errorText, S } from '../../shared/strings.js';
import { flashTab } from '../attention/flash.js';
import { applyFocusTarget, whenShown } from '../attention/focus-target.js';
import { useHostSupports } from '../lib/capabilities.js';
import { workKey as workKeyOf } from '../lib/tree-order.js';
import { dndId, type DropTargetData } from '../layout/dnd.js';
import { useTerminalDropPreview } from '../layout/DropIndicator.js';
import { useLayoutStore } from '../layout/store.js';
import { tabMeta } from '../layout/tab-meta.js';
import { focusTab, openTab, openTerminalSessionIds } from '../layout/tree.js';
import { ErrorBoundary } from '../shell/ErrorBoundary.js';
import { useUiStore } from '../store/ui.js';
import { useWorksStore } from '../store/works.js';
import { LinkMenu, openLinkPath, openLinkUrl, type LinkMenuState } from './LinkMenu.js';
import { sessionCwd, type TerminalLink } from './links.js';
import { SearchBar } from './SearchBar.js';
import { dragHasFiles, pasteHasOnlyImage, pathsToInput } from './drop.js';
import { sendWithToast, type SendWithToastDeps } from './send.js';
import { TerminalContextMenu } from './TerminalContextMenu.js';
import { useTerminal } from './use-terminal.js';
import { xtermTheme } from './xterm-themes.js';

export interface TerminalSurfaceProps {
  bridge: HarnasBridge;
  /** Из него же `workKey` для `requestCloseTabs`. */
  sessionRef: SessionRef;
  tabId: string;
  /** Якорь `--g-<groupId>` — тело группы объявляет его в `GroupView.tsx`. */
  groupId: string;
  visible: boolean;
  fontFamily: string;
  fontSize: number;
}

/**
 * openSearch() — с 2.5, с 5.3 открывает SearchBar с фокусом в поле.
 * clear() — с 5.3: term.clear(), агенту ничего не уходит. Их зовут действия find и terminal.clear (6.3).
 */
export interface TerminalSurfaceHandle {
  focus(): void;
  scrollToBottom(): void;
  search: SearchAddon | null;
  openSearch(): void;
  clear(): void;
}

/** Реестр живых поверхностей для фокуса, прокрутки и поиска (4.3, 5.3). */
export const terminalSurfaces: Map<string /* refKey */, TerminalSurfaceHandle> = new Map();

// ESC и управляющие байты в регулярках — ровно то, что вырезается из вставки.
/* eslint-disable no-control-regex */
const PASTE_CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// C0 кроме \t, \n, \r (их xterm обработает сам) и DEL; остатки ESC — тоже здесь.
const PASTE_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
/* eslint-enable no-control-regex */

/**
 * Текст вставки без управляющих байтов (кусок 5.1, раунд исправлений 2). Хост
 * разбирает вставку по маркерам ESC[200~/ESC[201~ и не может отличить маркер от
 * таких же байтов в содержимом (скопированный сырой лог терминала): поддельный
 * конец вставки сделал бы её хвост «вводом человека», и его \r снял бы черновик.
 * CSI вырезается целиком, чтобы от маркера не оставался мусор «[201~».
 */
function sanitizePaste(text: string): string {
  return text.replace(PASTE_CSI, '').replace(PASTE_CONTROL, '');
}

/** Сессия из снимка работ — для «Resume» тоста отправки; null — её уже нет. */
function sessionOf(ref: SessionRef): WorkSession | null {
  const entry = useWorksStore
    .getState()
    .entries.find((item) => item.projectPath === ref.projectPath && item.map.work.id === ref.workId);
  return entry?.map.sessions.find((item) => item.id === ref.sessionId) ?? null;
}

/**
 * «Open S02» тоста отправки (кусок 5.4): тот же переход, что клик по уведомлению в `App.tsx`
 * (4.3) — работа, вкладка сессии и фокус терминала. Цели нет — тот же тост.
 */
function openSessionTab(ref: SessionRef): void {
  const applied = applyFocusTarget(
    { kind: 'session', ref },
    {
      works: useWorksStore.getState().entries,
      setActiveWork: (key) => useLayoutStore.getState().setActiveWork(key),
      openTab: (key, tab) => {
        useLayoutStore.getState().apply(key, (layout) => openTab(layout, tab));
      },
      whenShown,
      surface: (target) => terminalSurfaces.get(refKey(target)),
      flash: (key, id) => flashTab(key, id),
    },
  );
  if (!applied) toast(S.notifications.targetGone);
}

/** Случайный id монтирования — не `crypto.randomUUID`: тот требует защищённого контекста. */
function newMountId(): string {
  return `m-${Math.random().toString(36).slice(2, 10)}`;
}

export function TerminalSurface(props: TerminalSurfaceProps): JSX.Element {
  const { sessionRef, tabId, groupId, visible } = props;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [mountId] = useState(newMountId);
  const dark = useUiStore((state) => state.dark);
  const key = workKeyOf(sessionRef.projectPath, sessionRef.workId);
  const dropData: DropTargetData = { workKey: key, kind: 'terminal', sessionId: sessionRef.sessionId };
  const drop = useDroppable({ id: dndId.terminal(key, tabId), data: dropData, disabled: !visible });
  const { setNodeRef } = drop;
  const setRoot = useCallback(
    (node: HTMLDivElement | null) => {
      rootRef.current = node;
      setNodeRef(node);
    },
    [setNodeRef],
  );
  // Рамка терминала — индикатор броска в него (спека 5.4).
  const dropTarget = useTerminalDropPreview(key, sessionRef.sessionId) && visible;
  const entry = useWorksStore((state) =>
    state.entries.find((item) => item.projectPath === sessionRef.projectPath && item.map.work.id === sessionRef.workId),
  );
  const tab: TabSpec = { kind: 'terminal', id: tabId, sessionId: sessionRef.sessionId };
  const title = tabMeta(tab, entry ?? null).title;

  // Якорные свойства — через `setProperty`: в `CSSProperties` @types/react 18
  // их нет. `useLayoutEffect`, чтобы поверхность не мелькнула в углу слоя до
  // привязки. При переносе вкладки меняется только `position-anchor`.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (el === null) return;
    el.style.setProperty('position-anchor', `--g-${groupId}`);
    el.style.setProperty('top', 'anchor(top)');
    el.style.setProperty('left', 'anchor(left)');
    el.style.setProperty('width', 'anchor-size(width)');
    el.style.setProperty('height', 'anchor-size(height)');
  }, [groupId]);

  // `inert` в React 18 — не булев проп, ставится руками. Скрытая поверхность —
  // `visibility: hidden`, а не `display: none`: xterm без размеров их теряет.
  useLayoutEffect(() => {
    rootRef.current?.toggleAttribute('inert', !visible);
  }, [visible]);

  // Видимость сессии — для «просмотрено» и уведомлений (`attention/seen.ts#visibleSessions`), как у
  // `panel-registry.tsx`: на каждую смену и `false` при размонтировании.
  const sessionKey = refKey(sessionRef);
  useEffect(() => {
    useUiStore.getState().setSessionVisible(sessionKey, visible);
  }, [sessionKey, visible]);
  useEffect(() => () => useUiStore.getState().setSessionVisible(sessionKey, false), [sessionKey]);

  // Поверхность — сосед `GroupView`, а не потомок: его `onPointerDownCapture`
  // клик по терминалу не видит, и ⌘F/«Split»/⌘[ ⌘] ушли бы в прежнюю активную
  // группу. Поэтому группу (и вкладку в ней) делает активной сама поверхность —
  // и по клику, и по фокусу клавиатурой. Capture и без `preventDefault`, чтобы
  // не мешать выделению в xterm; в уже активной группе `focusTab` отдаёт ту же
  // ссылку, и `apply` ничего не пишет.
  const focusOwnTab = (): void => {
    useLayoutStore.getState().apply(key, (layout) => focusTab(layout, tabId));
  };

  return (
    <div
      ref={setRoot}
      data-tab-id={tabId}
      data-mount-id={mountId}
      className="absolute overflow-hidden"
      onPointerDownCapture={focusOwnTab}
      onFocusCapture={focusOwnTab}
      style={{
        visibility: visible ? 'visible' : 'hidden',
        backgroundColor: xtermTheme(dark).background,
        ...(dropTarget ? { outline: '2px solid rgb(59,130,246)', outlineOffset: '-2px' } : {}),
      }}
    >
      <ErrorBoundary title={title} onClose={() => void useLayoutStore.getState().requestCloseTabs(key, [tabId])}>
        <SurfaceInner {...props} />
      </ErrorBoundary>
    </div>
  );
}

/**
 * `memo` (раунд исправлений 1, ревью A): рамка броска перерисовывает корень
 * поверхности, а пропы внутреннего компонента — те же ссылки, и xterm с
 * `use-terminal` при этом не трогаются.
 */
const SurfaceInner = memo(function SurfaceInner({ bridge, sessionRef, tabId, visible, fontFamily, fontSize }: TerminalSurfaceProps): JSX.Element {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const key = workKeyOf(sessionRef.projectPath, sessionRef.workId);
  // Папка сессии для относительных путей ссылок (спека 8.3): worktree, когда он создан,
  // иначе проект. Селектор отдаёт строку — перерисовка только при её смене.
  const cwd = useWorksStore((state) => {
    const entry = state.entries.find((item) => item.projectPath === sessionRef.projectPath && item.map.work.id === sessionRef.workId);
    const session = entry?.map.sessions.find((item) => item.id === sessionRef.sessionId);
    return session === undefined ? sessionRef.projectPath : sessionCwd(session, sessionRef.projectPath);
  });
  const [searchOpen, setSearchOpen] = useState(false);
  const [linkMenu, setLinkMenu] = useState<LinkMenuState | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    // Уже открытая полоса `autoFocus` второй раз не сработает — фокус руками.
    inputRef.current?.focus();
  }, []);

  // Обычный клик — меню у курсора; ⌘-клик — сразу действие: путь — приложение по умолчанию
  // (редактор — с 7.3), адрес — системный браузер (встроенный — с 9.2).
  const onLink = useCallback(
    (link: TerminalLink, event: MouseEvent) => {
      if (event.metaKey) {
        if (link.kind === 'path') void openLinkPath(bridge, link.absPath);
        else openLinkUrl(bridge, link.url);
        return;
      }
      setLinkMenu({ link, x: event.clientX, y: event.clientY });
    },
    [bridge],
  );

  const { search, terminal, offline } = useTerminal({
    bridge,
    ref: sessionRef,
    container,
    fontFamily,
    fontSize,
    visible,
    workKey: key,
    cwd,
    onFind: openSearch,
    onLink,
  });
  const dark = useUiStore((state) => state.dark);

  // Ручка читает свежие `search`/`terminal` через ref: сама она заводится один
  // раз и живёт в реестре всё время монтирования (тест 5), а не пересоздаётся
  // на каждое открытие терминала.
  const liveRef = useRef<{ search: SearchAddon | null; terminal: Terminal | null }>({ search, terminal });
  liveRef.current = { search, terminal };

  // Переход по уведомлению (кусок 4.3) зовёт прокрутку и фокус, как только поверхность
  // видима, а xterm `use-terminal` создаёт эффектом чуть позже: просьба до него ждёт терминала.
  const deferredRef = useRef({ focus: false, scrollToBottom: false });
  useEffect(() => {
    if (terminal === null) return;
    const deferred = deferredRef.current;
    if (deferred.scrollToBottom) terminal.scrollToBottom();
    if (deferred.focus) terminal.focus();
    deferredRef.current = { focus: false, scrollToBottom: false };
  }, [terminal]);

  const handle = useMemo<TerminalSurfaceHandle>(
    () => ({
      focus: () => {
        const current = liveRef.current.terminal;
        if (current === null) deferredRef.current.focus = true;
        else current.focus();
      },
      scrollToBottom: () => {
        const current = liveRef.current.terminal;
        if (current === null) deferredRef.current.scrollToBottom = true;
        else current.scrollToBottom();
      },
      get search() {
        return liveRef.current.search;
      },
      openSearch,
      clear: () => liveRef.current.terminal?.clear(),
    }),
    [openSearch],
  );

  // «Split right/down» меню терминала — как в меню вкладки (`layout/Tab.tsx#beginSplit`):
  // сначала своя вкладка активна, затем выбор сессии для новой группы.
  const beginSplit = (direction: 'right' | 'down'): void => {
    useLayoutStore.getState().apply(key, (layout) => focusTab(layout, tabId));
    const layout = useLayoutStore.getState().layouts[key];
    useUiStore.getState().openPicker({ workKey: key, direction, openSessionIds: openTerminalSessionIds(layout) });
  };

  // Отправка агенту — только явным действием человека: бросок файла или вставка скриншота
  // (кусок 5.4, спека 8.5). Без `pty.send` у хоста (спека 3.2, 13) ни то ни другое не
  // перехватывается: вставка идёт в xterm как прежде, бросок не принимается.
  const canSend = useHostSupports('pty.send');
  const sendDeps = useMemo<SendWithToastDeps>(() => ({ bridge, session: sessionOf, openSession: openSessionTab }), [bridge]);
  const [dropping, setDropping] = useState(false);

  // Вставка — через xterm, но уже чистым текстом (sanitizePaste): capture на
  // контейнере срабатывает раньше обработчика paste скрытого поля xterm, а
  // stopPropagation не даёт xterm вставить сырой текст второй раз. xterm.paste
  // сам обернёт текст в bracketed paste и переведёт переводы строк.
  // Картинка без текста (кусок 5.4) — в том же слушателе: main сохраняет её в drops/, агенту
  // уходит путь. Одного preventDefault мало: xterm defaultPrevented не смотрит и вставил бы
  // пустой текст — при bracketed paste агент получил бы ESC[200~ESC[201~ вдобавок к пути.
  useEffect(() => {
    if (container === null || terminal === null) return;
    const pasteScreenshot = async (): Promise<void> => {
      let saved: string | null;
      try {
        saved = await bridge.app.saveDropImage('clipboard');
      } catch (error) {
        const { code, message } = decodeIpcError(error);
        console.warn('[harnas] saveDropImage', message);
        toast.error(errorText(code, S.errors.actions.saveScreenshot));
        return;
      }
      if (saved !== null) await sendWithToast(sendDeps, sessionRef, pathsToInput([saved]), false);
    };
    const onPaste = (event: ClipboardEvent): void => {
      const data = event.clipboardData;
      const text = data?.getData('text/plain') ?? '';
      if (text === '') {
        if (data === null || !canSend || !pasteHasOnlyImage(data)) return;
        event.preventDefault();
        event.stopPropagation();
        void pasteScreenshot();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const clean = sanitizePaste(text);
      if (clean !== '') terminal.paste(clean);
    };
    container.addEventListener('paste', onPaste, true);
    return () => container.removeEventListener('paste', onPaste, true);
  }, [container, terminal, canSend, bridge, sendDeps, sessionRef]);

  // Файлы из Finder (спека 8.5): бросок принимается, только если тащат файлы — иначе строка
  // текста или ссылка из другого приложения тоже стала бы «файлом». Пути — без Enter.
  const onDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (!canSend || !dragHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDropping(true);
  };
  const onDragLeave = (event: DragEvent<HTMLDivElement>): void => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false);
  };
  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    setDropping(false);
    if (!canSend || !dragHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    // Пустой путь — у `File` нет места на диске (синтетический): пропускаем.
    const paths = Array.from(event.dataTransfer.files)
      .map((file) => bridge.app.pathForFile(file))
      .filter((path) => path !== '');
    if (paths.length > 0) void sendWithToast(sendDeps, sessionRef, pathsToInput(paths), false);
  };

  const sessionKey = refKey(sessionRef);
  useEffect(() => {
    terminalSurfaces.set(sessionKey, handle);
    return () => {
      if (terminalSurfaces.get(sessionKey) === handle) terminalSurfaces.delete(sessionKey);
    };
  }, [sessionKey, handle]);

  return (
    <div
      className="relative flex h-full min-w-0 flex-col"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={dropping ? { outline: '2px solid rgb(59,130,246)', outlineOffset: '-2px' } : undefined}
    >
      {searchOpen ? (
        <SearchBar
          ref={inputRef}
          search={search}
          onClose={() => {
            setSearchOpen(false);
            terminal?.focus();
          }}
        />
      ) : null}
      {/* Отступ 4px — на обёртке, а не на контейнере xterm: FitAddon меряет
          родителя терминала и падинг контейнера не заметил бы (как в
          `TerminalPanel.tsx`). Фон — фон темы xterm, а не `--card`. */}
      <TerminalContextMenu
        bridge={bridge}
        terminal={terminal}
        onClear={() => terminal?.clear()}
        onFind={openSearch}
        onSplit={beginSplit}
      >
        <div data-testid="terminal-surface-pad" className="min-h-0 flex-1 p-1" style={{ backgroundColor: xtermTheme(dark).background }}>
          <div ref={setContainer} className="h-full w-full" />
        </div>
      </TerminalContextMenu>
      {linkMenu === null ? null : <LinkMenu bridge={bridge} state={linkMenu} onClose={() => setLinkMenu(null)} />}
      {/* Без связи с хостом ввод не уходит (`use-terminal.ts`) — человек должен это видеть, а не
          печатать в пустоту (раунд lane-r3, п. 2). Слой ловит клики, экран под ним виден. */}
      {offline ? (
        <div
          data-testid="terminal-offline"
          role="status"
          className="absolute inset-0 z-10 flex items-center justify-center bg-black/50 px-4 text-center text-sm text-neutral-100"
        >
          {S.terminal.disconnected}
        </div>
      ) : null}
    </div>
  );
});
