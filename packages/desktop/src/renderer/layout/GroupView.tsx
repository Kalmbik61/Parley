/**
 * Тело одной группы (кусок 2.4, спека 5.3, 5.8, 5.10): строка вкладок (или
 * портал в заголовок — решает `singleGroup`, спека 5.3) плюс тело активной
 * вкладки. `LayoutBodyContext` определён здесь и потребляется тут же — тем
 * же приёмом, что и `PanelHostContext` в прежнем `panel-registry.tsx`
 * («Workspace.tsx» брал контекст ОТТУДА, а не наоборот): `LayoutView.tsx`
 * рендерит `GroupView` (через `SplitView`), поэтому если бы контекст жил в
 * `LayoutView.tsx`, а `GroupView.tsx` его импортировал — вышел бы цикл
 * импортов. Здесь контекст только СНИМАЕТСЯ и раздаётся телам явными пропами
 * (`TerminalBody` нужен шрифт, `MailBody`/`RoomBody`/`DiffBody` — мост) — сами
 * тела ничего о контексте не знают, как и прежние `TerminalPanel`/`MailPanel`.
 *
 * `data-group-id` на корне — для `AppShell.tsx#measureGroupSizes`
 * (`getBoundingClientRect` при «Разделить», спека 5.2 «Числа»: минимум
 * 240×160). Клик где угодно в группе фокусирует её — без этого ⌃1–9 и
 * «Разделить» из меню действовали бы не на ту группу, куда только что кликнули.
 *
 * Кусок 2.6 (спека 5.4): тело — droppable `body`, центр или край решает
 * `zoneForPoint` по точке броска. У неактивной работы зона выключена: тела
 * скрытых работ LRU лежат на месте тела активной. Тело позиционировано
 * (`relative`) ради `DropIndicator`, но без `z-index` — своего контекста
 * наложения не создаёт, и индикатор встаёт над поверхностью терминала.
 */

import { createContext, useCallback, useContext, useLayoutEffect, useRef } from 'react';
import { useDroppable } from '@dnd-kit/core';
import type { WorkEntry, WorkSession } from '@harnas/core';
import type { SessionRef } from '@harnas/protocol';
import type { GroupNode, TabSpec } from '../../shared/layout-types.js';
import type { HarnasBridge } from '../../shared/bridge.js';
import { S } from '../../shared/strings.js';
import { ErrorBoundary } from '../shell/ErrorBoundary.js';
import { DiffBody } from './bodies/DiffBody.js';
import { MailBody } from './bodies/MailBody.js';
import { MissingBody } from './bodies/MissingBody.js';
import { RoomBody } from './bodies/RoomBody.js';
import { TerminalBody } from './bodies/TerminalBody.js';
import { dndId, type DropTargetData } from './dnd.js';
import { DropIndicator, useDropPreview } from './DropIndicator.js';
import { TabStrip } from './TabStrip.js';
import { useLayoutStore } from './store.js';
import { focusGroup } from './tree.js';

export interface LayoutBodyContextValue {
  bridge: HarnasBridge;
  fontFamily: string;
  fontSize: number;
  /**
   * Работа активна (кусок 2.5): у неактивной работы LRU единственная группа
   * не порталит строку вкладок в `#titlebar-tabs` — там строка только
   * активной работы.
   */
  active: boolean;
}

export const LayoutBodyContext = createContext<LayoutBodyContextValue | null>(null);

function useLayoutBody(): LayoutBodyContextValue {
  const value = useContext(LayoutBodyContext);
  if (value === null) throw new Error('GroupView: tab body outside LayoutBodyContext (LayoutView.tsx must provide it)');
  return value;
}

interface TabBodyProps {
  tab: TabSpec;
  entry: WorkEntry;
  host: LayoutBodyContextValue;
  onMissing: () => void;
}

function refOf(entry: WorkEntry, sessionId: string): SessionRef {
  return { projectPath: entry.projectPath, workId: entry.map.work.id, sessionId };
}

/** Отдельный компонент, а не просто функция в теле `GroupView`: бросок должен случиться ВНУТРИ дерева `ErrorBoundary`, иначе граница ошибки его не поймает. */
function TabBody({ tab, entry, host, onMissing }: TabBodyProps): JSX.Element {
  switch (tab.kind) {
    case 'terminal': {
      const session = entry.map.sessions.find((candidate) => candidate.id === tab.sessionId);
      if (session === undefined) return <MissingBody kind="session" onClose={onMissing} />;
      // Сам терминал — в слое поверхностей (`SurfaceLayer.tsx`, кусок 2.5).
      return <TerminalBody />;
    }
    case 'mail':
      return <MailBody bridge={host.bridge} entry={entry} />;
    case 'room': {
      const room = entry.map.rooms.find((candidate) => candidate.id === tab.roomId);
      if (room === undefined) return <MissingBody kind="room" onClose={onMissing} />;
      return <RoomBody bridge={host.bridge} entry={entry} roomId={tab.roomId} />;
    }
    case 'diff': {
      const session: WorkSession | undefined = entry.map.sessions.find((candidate) => candidate.id === tab.sessionId);
      if (session === undefined) return <MissingBody kind="session" onClose={onMissing} />;
      return <DiffBody bridge={host.bridge} sessionRef={refOf(entry, tab.sessionId)} session={session} />;
    }
    case 'file':
    case 'browser':
      // Эти виды вкладок появятся в этапах 7 и 9 — открыть их пока неоткуда
      // (`openTab` с таким `kind` этот кусок нигде не зовёт), сюда не дойти;
      // `ErrorBoundary` вокруг ловит бросок, если это всё же случится.
      throw new Error(`GroupView: tab kind "${tab.kind}" is not available yet`);
  }
}

export interface GroupViewProps {
  workKey: string;
  group: GroupNode;
  entry: WorkEntry;
  /** Единственная группа во всей раскладке работы — её строка вкладок портали­руется в заголовок (спека 5.3). */
  singleGroup: boolean;
}

export function GroupView({ workKey, group, entry, singleGroup }: GroupViewProps): JSX.Element {
  const host = useLayoutBody();
  const activeTab = group.tabs.find((candidate) => candidate.id === group.activeTabId) ?? null;

  // Тело группы — якорь поверхностей слоя (спека 5.5): `anchor-name` через
  // `setProperty`, в `CSSProperties` @types/react 18 его нет.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const bodyData: DropTargetData = { workKey, kind: 'body', groupId: group.id };
  const { setNodeRef } = useDroppable({ id: dndId.body(workKey, group.id), data: bodyData, disabled: !host.active });
  const setBody = useCallback(
    (node: HTMLDivElement | null) => {
      bodyRef.current = node;
      setNodeRef(node);
    },
    [setNodeRef],
  );
  const preview = useDropPreview();
  const target = (preview?.kind === 'center' || preview?.kind === 'edge') && preview.groupId === group.id ? preview : null;
  useLayoutEffect(() => {
    bodyRef.current?.style.setProperty('anchor-name', `--g-${group.id}`);
  }, [group.id]);

  const closeActive = (): void => {
    if (activeTab === null) return;
    void useLayoutStore.getState().requestCloseTabs(workKey, [activeTab.id]);
  };

  return (
    <div
      data-group-id={group.id}
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col"
      onPointerDownCapture={() => useLayoutStore.getState().apply(workKey, (layout) => focusGroup(layout, group.id))}
    >
      {/* Неактивная работа с одной группой строку не рисует вовсе: в заголовке
          место активной работы, а строка на месте поменяла бы высоту тела —
          и размер терминала при возврате к работе. */}
      {singleGroup && !host.active ? null : (
        <TabStrip workKey={workKey} group={group} entry={entry} portal={singleGroup} active={host.active} />
      )}
      <div ref={setBody} data-group-body={group.id} className="relative min-h-0 min-w-0 flex-1">
        {target === null ? null : <DropIndicator edge={target.kind === 'edge' ? target.edge : null} />}
        {group.tabs.length === 0 ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
            {S.tabs.emptyGroup}
          </div>
        ) : activeTab === null ? null : (
          <ErrorBoundary key={activeTab.id} title={S.shell.layoutError} onClose={closeActive}>
            <TabBody tab={activeTab} entry={entry} host={host} onMissing={closeActive} />
          </ErrorBoundary>
        )}
      </div>
    </div>
  );
}
