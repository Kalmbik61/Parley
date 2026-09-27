/**
 * Сетка панелей на dockview (кусок 2.1 плана окна, спека 4.4, 5.1, 5.2):
 * несколько живых сессий рядом вместо одной панели `App.tsx` этапа 1.
 *
 * «Открыть сессию» — фокус на уже существующую панель (тот же `panelId`) или
 * новая вкладка в активной группе. Перетаскивание строки сайдбара — деление
 * по краю панели или вкладка в её группе, в зависимости от того, куда упал
 * курсор (`api.onDidDrop`, dockview сам решает край/центр). ⌘D/⇧⌘D зовут
 * `openPicker` стора `store/ui.ts` — сам `SessionPicker` и палитру ⌘K с куска
 * 2.3 монтирует `shell/AppShell.tsx`, а не этот компонент: они нужны и на
 * экране `Landing`, где `Workspace` вовсе не смонтирован. ⌘W закрывает
 * активную панель (`pty.detach` — в `use-terminal.ts`, через размонтирование
 * при `removePanel`, не здесь). ⌘[/⌘] — соседняя панель по порядку `api.panels`.
 *
 * Заведён как `dockview` в плане куска, но пакет `dockview` на деле (v8)
 * реэкспортирует только `dockview-core` без React — раскладка на React/Vue/…
 * с версии 8 разъехалась по отдельным пакетам (`dockview-react` и т. д.).
 * Используется `dockview-react`: она сама реэкспортирует всё из `dockview`,
 * так что второй прямой зависимости не нужно.
 */

import 'dockview-react/dist/styles/dockview.css';
import '../../styles/dockview.css';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import {
  DockviewReact,
  positionToDirection,
  type DockviewApi,
  type DockviewReadyEvent,
  type DockviewTheme,
  type Direction,
  type IDockviewPanel,
} from 'dockview-react';
import type { WorkEntry } from '@harnas/core';
import type { SessionRef } from '@harnas/protocol';
import type { HarnasBridge } from '../../../shared/bridge.js';
import { S } from '../../../shared/strings.js';
import { sessionRowLabel } from '../../lib/participant.js';
import { panelId, specFromPanelId, workKey, type PanelSpec } from '../../lib/panel-id.js';
import { useUiStore } from '../../store/ui.js';
import { PANEL_COMPONENTS, PanelHostContext } from './panel-registry.js';
import { readDragPayload } from './sidebar-drag.js';
import { useLayoutPersistence } from './use-layout-persistence.js';
import { useWorksStore } from '../../store/works.js';

export interface WorkspaceHandle {
  /** Сайдбар (клик по строке сессии) — фокус на панель или новая вкладка (тест 2). */
  openSession(ref: SessionRef, sessionWorkKey: string, title: string): void;
  /** Строка «вся почта работы» в сайдбаре (кусок 2.4) — тот же принцип: фокус или новая вкладка. */
  openMail(sessionWorkKey: string): void;
  /** Строка комнаты в сайдбаре (кусок 3.6) — тот же принцип: фокус или новая вкладка. */
  openRoom(sessionWorkKey: string, roomId: string, title: string): void;
  /** «Изменения» из меню сессии (кусок 4.3) — тот же принцип: фокус или новая вкладка. */
  openChanges(ref: SessionRef, sessionWorkKey: string, title: string): void;
  /**
   * Выбор в `SessionPicker` (кусок 2.3) — открыть сессию рядом с ПОКА ЕЩЁ
   * активной панелью (диалог модальный, между `openPicker` в `Workspace` и
   * выбором в `AppShell` активная панель dockview не меняется).
   */
  openBeside(ref: SessionRef, sessionWorkKey: string, title: string, direction: 'right' | 'down'): void;
  /** Палитра ⌘K (кусок 2.3, «Закрыть панель») — та же логика, что у ⌘W. */
  closeActivePanel(): void;
}

export interface WorkspaceProps {
  bridge: HarnasBridge;
  works: readonly WorkEntry[];
  fontFamily: string;
  fontSize: number;
}

/**
 * Своя тема dockview вместо каталожной Catppuccin — только имя и класс:
 * цвета берёт `styles/dockview.css` из токенов (кусок 1.3 плана окна, спека
 * 4.7). Файл и эта тема временные: dockview целиком уходит в 2.7.
 */
const dockviewTheme: DockviewTheme = { name: 'harnas', className: 'dockview-theme-harnas' };

interface PanelPosition {
  direction: Direction;
  referencePanel?: string;
  referenceGroup?: string;
}

function findWork(works: readonly WorkEntry[], key: string): WorkEntry | undefined {
  return works.find((entry) => workKey(entry.projectPath, entry.map.work.id) === key);
}

/** Заголовок вкладки: для терминала/изменений — ярлык сессии, для комнаты — её название. */
function titleFor(spec: PanelSpec, entry: WorkEntry | undefined): string {
  if (spec.kind === 'terminal' || spec.kind === 'changes') {
    if (spec.ref === undefined) return spec.kind;
    const label = entry?.map.sessions.find((session) => session.id === spec.ref?.sessionId)?.label ?? '';
    return sessionRowLabel(spec.ref.sessionId, label);
  }
  if (spec.kind === 'mail') return S.mail.allWorkspaceMail;
  return entry?.map.rooms.find((room) => room.id === spec.roomId)?.title ?? S.rooms.fallbackTitle;
}

function openOrFocus(api: DockviewApi, spec: PanelSpec, title: string, position?: PanelPosition): void {
  const id = panelId(spec);
  const existing = api.getPanel(id);
  if (existing !== undefined) {
    existing.api.setActive();
    return;
  }
  api.addPanel({ id, component: spec.kind, title, params: spec, ...(position !== undefined ? { position } : {}) });
}

function focusAdjacent(api: DockviewApi, delta: 1 | -1): void {
  const panels = api.panels;
  if (panels.length === 0) return;
  const active = api.activePanel;
  const index = active === undefined ? -1 : panels.findIndex((panel) => panel.id === active.id);
  const nextIndex = (((index === -1 ? 0 : index + delta) % panels.length) + panels.length) % panels.length;
  panels[nextIndex]?.api.setActive();
}

function specOf(panel: IDockviewPanel): PanelSpec {
  return specFromPanelId(panel.id) ?? panel.api.getParameters<PanelSpec>();
}

export const Workspace = forwardRef<WorkspaceHandle, WorkspaceProps>(function Workspace(
  { bridge, works, fontFamily, fontSize },
  handleRef,
) {
  const apiRef = useRef<DockviewApi | null>(null);
  // Кандидатам `SessionPicker` и заголовкам вкладок при перетаскивании нужен
  // свежий список работ, а колбэки dockview заведены один раз в `onReady`.
  const worksRef = useRef(works);
  worksRef.current = works;

  // Общая точка входа «открыть сессию в сетке» — и для `openSession` из
  // `WorkspaceHandle` (клик в сайдбаре), и для команд палитры ⌘K (кусок 2.3).
  const openSessionInGrid = (sessionRef: SessionRef, sessionWorkKey: string, title: string): void => {
    const api = apiRef.current;
    if (api === null) return;
    openOrFocus(api, { kind: 'terminal', ref: sessionRef, workKey: sessionWorkKey }, title);
  };

  // Заголовок вкладки всегда один и тот же (`titleFor`) — панель на весь адрес
  // `mail:<workKey>`, а не на конкретную работу по имени, так что второй
  // «вся почта работы» другой работы не перезаписывает эту вкладку.
  const openMailInGrid = (sessionWorkKey: string): void => {
    const api = apiRef.current;
    if (api === null) return;
    openOrFocus(api, { kind: 'mail', workKey: sessionWorkKey }, S.mail.allWorkspaceMail);
  };

  // Строка комнаты в сайдбаре (кусок 3.6) и команда палитры ⌘K — тот же
  // принцип, что и у «всей почты работы»: панель на весь адрес
  // `room:<workKey>:<roomId>`, а не на конкретную работу по имени.
  const openRoomInGrid = (sessionWorkKey: string, roomId: string, title: string): void => {
    const api = apiRef.current;
    if (api === null) return;
    openOrFocus(api, { kind: 'room', workKey: sessionWorkKey, roomId }, title);
  };

  // «Изменения» из меню сессии (кусок 4.3) — адрес панели тот же, что и у
  // терминала (`ref`), но отдельный вид: `panelId` различает их по префиксу.
  const openChangesInGrid = (sessionRef: SessionRef, sessionWorkKey: string, title: string): void => {
    const api = apiRef.current;
    if (api === null) return;
    openOrFocus(api, { kind: 'changes', ref: sessionRef, workKey: sessionWorkKey }, title);
  };

  // `apiRef` — для императивных вызовов (открыть/закрыть панель), а это
  // состояние — специально для `useLayoutPersistence` (кусок 2.2): хук должен
  // сам перезапустить свой эффект, когда dockview станет готов, а ref такого
  // сигнала React не даёт.
  const [api, setApi] = useState<DockviewApi | null>(null);
  const worksLoaded = useWorksStore((state) => !state.loading);
  useLayoutPersistence({ api, bridge, works, worksLoaded });

  useImperativeHandle(
    handleRef,
    () => ({
      openSession: openSessionInGrid,
      openMail: openMailInGrid,
      openRoom: openRoomInGrid,
      openChanges: openChangesInGrid,
      openBeside: (sessionRef, sessionWorkKey, title, direction) => {
        const api = apiRef.current;
        if (api === null) return;
        const active = api.activePanel;
        const position: PanelPosition | undefined =
          active === undefined ? undefined : { direction: direction === 'right' ? 'right' : 'below', referencePanel: active.id };
        openOrFocus(api, { kind: 'terminal', ref: sessionRef, workKey: sessionWorkKey }, title, position);
      },
      closeActivePanel: () => {
        apiRef.current?.activePanel?.api.close();
      },
    }),
    [],
  );

  const handleReady = (event: DockviewReadyEvent): void => {
    const api = event.api;
    apiRef.current = api;
    setApi(api);

    api.onDidActivePanelChange(({ panel }) => {
      useUiStore.getState().setActivePanelId(panel?.id ?? null);
      if (panel === undefined) return;
      const spec = specOf(panel);
      if (spec.kind === 'terminal' && spec.ref !== undefined) {
        useUiStore.getState().selectSession(spec.workKey, spec.ref);
      }
    });

    api.onDidDrop((dropEvent) => {
      const native = dropEvent.nativeEvent;
      if (!(native instanceof DragEvent)) return;
      const spec = readDragPayload(native);
      if (spec === null) return;

      const entry = findWork(worksRef.current, spec.workKey);
      const title = titleFor(spec, entry);
      const direction = positionToDirection(dropEvent.position);
      const position: PanelPosition | undefined =
        dropEvent.panel !== undefined
          ? { direction, referencePanel: dropEvent.panel.id }
          : dropEvent.group !== undefined
            ? { direction, referenceGroup: dropEvent.group.id }
            : undefined;
      openOrFocus(api, spec, title, position);
    });
  };

  useEffect(
    () =>
      bridge.app.onMenu((action) => {
        const api = apiRef.current;
        if (api === null) return;

        if (action === 'close-panel') {
          api.activePanel?.api.close();
          return;
        }
        if (action === 'prev-panel') {
          focusAdjacent(api, -1);
          return;
        }
        if (action === 'next-panel') {
          focusAdjacent(api, 1);
          return;
        }
        if (action === 'split-right' || action === 'split-down') {
          const active = api.activePanel;
          if (active === undefined) return;
          const activeWorkKey = specOf(active).workKey;
          // Сессии ЭТОЙ работы, у которых уже открыт терминал — остальные и
          // есть кандидаты `SessionPicker` (спека 5.2). Панели других видов
          // (почта, комната, изменения) тут ни при чём — они не «сессия».
          const openSessionIds = api.panels
            .map((panel) => specFromPanelId(panel.id))
            .filter((spec): spec is PanelSpec & { ref: SessionRef } =>
              spec !== null && spec.kind === 'terminal' && spec.workKey === activeWorkKey && spec.ref !== undefined,
            )
            .map((spec) => spec.ref.sessionId);
          useUiStore.getState().openPicker({
            workKey: activeWorkKey,
            direction: action === 'split-right' ? 'right' : 'down',
            openSessionIds,
          });
        }
      }),
    [bridge],
  );

  return (
    <PanelHostContext.Provider value={{ bridge, fontFamily, fontSize }}>
      <div className="min-h-0 min-w-0 flex-1">
        <DockviewReact
          className="h-full w-full"
          components={PANEL_COMPONENTS}
          theme={dockviewTheme}
          onReady={handleReady}
        />
      </div>
    </PanelHostContext.Provider>
  );
});
