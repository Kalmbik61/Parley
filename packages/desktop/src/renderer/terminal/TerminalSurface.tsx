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
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { SearchAddon } from '@xterm/addon-search';
import { useDroppable } from '@dnd-kit/core';
import { refKey, type SessionRef } from '@harnas/protocol';
import type { HarnasBridge } from '../../shared/bridge.js';
import type { TabSpec } from '../../shared/layout-types.js';
import { S } from '../../shared/strings.js';
import { workKey as workKeyOf } from '../lib/tree-order.js';
import { dndId, type DropTargetData } from '../layout/dnd.js';
import { useTerminalDropPreview } from '../layout/DropIndicator.js';
import { useLayoutStore } from '../layout/store.js';
import { tabMeta } from '../layout/tab-meta.js';
import { focusTab } from '../layout/tree.js';
import { ErrorBoundary } from '../shell/ErrorBoundary.js';
import { useUiStore } from '../store/ui.js';
import { useWorksStore } from '../store/works.js';
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
 * openSearch() — с 2.5: полоса поиска из TerminalPanel с фокусом в поле.
 * 5.3 меняет полосу на SearchBar и дописывает clear(); их зовут действия find и terminal.clear (6.3).
 */
export interface TerminalSurfaceHandle {
  focus(): void;
  scrollToBottom(): void;
  search: SearchAddon | null;
  openSearch(): void;
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

  // Видимость сессии — для уведомлений (`App.tsx#wireNotifications`), как у
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
const SurfaceInner = memo(function SurfaceInner({ bridge, sessionRef, visible, fontFamily, fontSize }: TerminalSurfaceProps): JSX.Element {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const { search, terminal } = useTerminal({ bridge, ref: sessionRef, container, fontFamily, fontSize, visible });
  const dark = useUiStore((state) => state.dark);

  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Ручка читает свежие `search`/`terminal` через ref: сама она заводится один
  // раз и живёт в реестре всё время монтирования (тест 5), а не пересоздаётся
  // на каждое открытие терминала.
  const liveRef = useRef<{ search: SearchAddon | null; terminal: Terminal | null }>({ search, terminal });
  liveRef.current = { search, terminal };

  const handle = useMemo<TerminalSurfaceHandle>(
    () => ({
      focus: () => liveRef.current.terminal?.focus(),
      scrollToBottom: () => liveRef.current.terminal?.scrollToBottom(),
      get search() {
        return liveRef.current.search;
      },
      openSearch: () => {
        setSearchOpen(true);
        // Уже открытая полоса `autoFocus` второй раз не сработает — фокус руками.
        inputRef.current?.focus();
      },
    }),
    [],
  );

  // Вставка — через xterm, но уже чистым текстом (sanitizePaste): capture на
  // контейнере срабатывает раньше обработчика paste скрытого поля xterm, а
  // stopPropagation не даёт xterm вставить сырой текст второй раз. xterm.paste
  // сам обернёт текст в bracketed paste и переведёт переводы строк. Вставка без
  // текста (картинка) не трогается — её добавит кусок 5.4 сюда же.
  useEffect(() => {
    if (container === null || terminal === null) return;
    const onPaste = (event: ClipboardEvent): void => {
      const text = event.clipboardData?.getData('text/plain') ?? '';
      if (text === '') return;
      event.preventDefault();
      event.stopPropagation();
      const clean = sanitizePaste(text);
      if (clean !== '') terminal.paste(clean);
    };
    container.addEventListener('paste', onPaste, true);
    return () => container.removeEventListener('paste', onPaste, true);
  }, [container, terminal]);

  const sessionKey = refKey(sessionRef);
  useEffect(() => {
    terminalSurfaces.set(sessionKey, handle);
    return () => {
      if (terminalSurfaces.get(sessionKey) === handle) terminalSurfaces.delete(sessionKey);
    };
  }, [sessionKey, handle]);

  return (
    <div className="relative flex h-full min-w-0 flex-col">
      {searchOpen ? (
        <div className="absolute right-2 top-2 z-10 flex items-center gap-1 rounded border border-border bg-popover px-2 py-1">
          <input
            ref={inputRef}
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') search?.findNext(query);
              if (event.key === 'Escape') setSearchOpen(false);
            }}
            placeholder={S.terminal.findPlaceholder}
            className="w-48 bg-transparent text-sm text-popover-foreground outline-none"
          />
        </div>
      ) : null}
      {/* Отступ 4px — на обёртке, а не на контейнере xterm: FitAddon меряет
          родителя терминала и падинг контейнера не заметил бы (как в
          `TerminalPanel.tsx`). Фон — фон темы xterm, а не `--card`. */}
      <div data-testid="terminal-surface-pad" className="min-h-0 flex-1 p-1" style={{ backgroundColor: xtermTheme(dark).background }}>
        <div ref={setContainer} className="h-full w-full" />
      </div>
    </div>
  );
});
