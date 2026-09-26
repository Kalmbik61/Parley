/**
 * Сетка панелей на dockview (кусок 2.1 плана окна, спека 4.4, 5.1, 5.2):
 * несколько живых сессий рядом вместо одной панели `App.tsx` этапа 1.
 *
 * «Открыть сессию» — фокус на уже существующую панель (тот же `panelId`) или
 * новая вкладка в активной группе. Перетаскивание строки сайдбара — деление
 * по краю панели или вкладка в её группе, в зависимости от того, куда упал
 * курсор (`api.onDidDrop`, dockview сам решает край/центр). ⌘D/⇧⌘D открывают
 * `SessionPicker` и вставляют выбранную сессию справа/снизу от активной
 * панели. ⌘W закрывает активную панель (`pty.detach` — в `use-terminal.ts`,
 * через размонтирование при `removePanel`, не здесь). ⌘[/⌘] — соседняя
 * панель по порядку `api.panels`.
 *
 * Заведён как `dockview` в плане куска, но пакет `dockview` на деле (v8)
 * реэкспортирует только `dockview-core` без React — раскладка на React/Vue/…
 * с версии 8 разъехалась по отдельным пакетам (`dockview-react` и т. д.).
 * Используется `dockview-react`: она сама реэкспортирует всё из `dockview`,
 * так что второй прямой зависимости не нужно.
 */

import 'dockview-react/dist/styles/dockview.css';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import {
  DockviewReact,
  positionToDirection,
  themeCatppuccinMocha,
  type DockviewApi,
  type DockviewReadyEvent,
  type Direction,
  type IDockviewPanel,
} from 'dockview-react';
import type { WorkEntry } from '@harnas/core';
import type { SessionRef } from '@harnas/protocol';
import type { HarnasBridge } from '../../../shared/bridge.js';
import { buildCommands } from '../../lib/commands.js';
import { sessionRowLabel } from '../../lib/participant.js';
import { panelId, workKey, type PanelSpec } from '../../lib/panel-id.js';
import { useUiStore } from '../../store/ui.js';
import { PANEL_COMPONENTS, PanelHostContext } from './panel-registry.js';
import { readDragPayload } from './sidebar-drag.js';
import { useLayoutPersistence } from './use-layout-persistence.js';
import { CommandPalette } from '../palette/CommandPalette.js';
import { SessionPicker, sessionCandidates } from '../palette/SessionPicker.js';

export interface WorkspaceHandle {
  /** Сайдбар (клик по строке сессии) — фокус на панель или новая вкладка (тест 2). */
  openSession(ref: SessionRef, sessionWorkKey: string, title: string): void;
}

export interface WorkspaceProps {
  bridge: HarnasBridge;
  works: readonly WorkEntry[];
  theme: string;
  fontFamily: string;
  fontSize: number;
}

interface PanelPosition {
  direction: Direction;
  referencePanel?: string;
  referenceGroup?: string;
}

function findWork(works: readonly WorkEntry[], key: string): WorkEntry | undefined {
  return works.find((entry) => workKey(entry.projectPath, entry.map.work.id) === key);
}

/** Заголовок вкладки: для терминала/изменений — ярлык сессии, иначе — вид панели. */
function titleFor(spec: PanelSpec, entry: WorkEntry | undefined): string {
  if (spec.kind === 'terminal' || spec.kind === 'changes') {
    if (spec.ref === undefined) return spec.kind;
    const label = entry?.map.sessions.find((session) => session.id === spec.ref?.sessionId)?.label ?? '';
    return sessionRowLabel(spec.ref.sessionId, label);
  }
  return spec.kind === 'mail' ? 'Вся почта работы' : 'Комната';
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
  return panel.api.getParameters<PanelSpec>();
}

export const Workspace = forwardRef<WorkspaceHandle, WorkspaceProps>(function Workspace(
  { bridge, works, theme, fontFamily, fontSize },
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

  // `apiRef` — для императивных вызовов (открыть/закрыть панель), а это
  // состояние — специально для `useLayoutPersistence` (кусок 2.2): хук должен
  // сам перезапустить свой эффект, когда dockview станет готов, а ref такого
  // сигнала React не даёт.
  const [api, setApi] = useState<DockviewApi | null>(null);
  useLayoutPersistence({ api, bridge, works });

  const [picker, setPicker] = useState<{
    direction: 'right' | 'below';
    workKey: string;
    referencePanel: string;
  } | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Только для команд палитры (кусок 2.3): `buildCommands` не читает
  // `useUiStore` сам (см. комментарий в `lib/commands.ts`), поэтому нужную
  // часть его состояния забираем сюда селекторами, чтобы список команд
  // пересобирался при их изменении (например, подпись «пауза будильника»).
  const lastSessionByWork = useUiStore((state) => state.lastSessionByWork);
  const wakePaused = useUiStore((state) => state.wakePaused);
  const recentSessionRefs = useUiStore((state) => state.recentSessionRefs);

  useImperativeHandle(
    handleRef,
    () => ({
      openSession: openSessionInGrid,
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
        // Палитра открывается и без готового dockview (например, самый первый
        // кадр окна) — ей самой API сетки не нужен, только командам внутри.
        if (action === 'palette') {
          setPaletteOpen(true);
          return;
        }

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
          setPicker({
            direction: action === 'split-right' ? 'right' : 'below',
            workKey: specOf(active).workKey,
            referencePanel: active.id,
          });
        }
      }),
    [bridge],
  );

  const pickerEntry = picker === null ? undefined : findWork(works, picker.workKey);
  const openPanelIds = new Set(apiRef.current?.panels.map((panel) => panel.id) ?? []);
  const pickerCandidates = pickerEntry === undefined ? [] : sessionCandidates(pickerEntry, openPanelIds);

  const commands = buildCommands({
    works,
    lastSessionByWork,
    wakePaused,
    recentSessionRefs,
    actions: {
      openSession: openSessionInGrid,
      closeActivePanel: () => apiRef.current?.activePanel?.api.close(),
      newSession: () => {
        const ui = useUiStore.getState();
        ui.openNewSessionDialog(ui.selectedRef?.sessionId ?? null);
      },
      newWork: () => useUiStore.getState().openNewWorkDialog(),
      settings: () => useUiStore.getState().openSettingsDialog(),
      toggleWake: () => void useUiStore.getState().toggleWake(bridge),
    },
  });

  return (
    <PanelHostContext.Provider value={{ bridge, theme, fontFamily, fontSize }}>
      <div className="min-h-0 min-w-0 flex-1">
        <DockviewReact
          className="h-full w-full"
          components={PANEL_COMPONENTS}
          theme={themeCatppuccinMocha}
          onReady={handleReady}
        />
      </div>
      <SessionPicker
        open={picker !== null}
        candidates={pickerCandidates}
        onOpenChange={(open) => {
          if (!open) setPicker(null);
        }}
        onSelect={(sessionRef) => {
          const api = apiRef.current;
          if (api === null || picker === null) return;
          const label = sessionRowLabel(
            sessionRef.sessionId,
            pickerEntry?.map.sessions.find((session) => session.id === sessionRef.sessionId)?.label ?? '',
          );
          openOrFocus(api, { kind: 'terminal', ref: sessionRef, workKey: picker.workKey }, label, {
            direction: picker.direction === 'right' ? 'right' : 'below',
            referencePanel: picker.referencePanel,
          });
          setPicker(null);
        }}
      />
      <CommandPalette
        open={paletteOpen}
        commands={commands}
        onOpenChange={(open) => setPaletteOpen(open)}
      />
    </PanelHostContext.Provider>
  );
});
