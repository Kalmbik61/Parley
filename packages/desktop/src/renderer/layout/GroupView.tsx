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
import type { WorkEntry, WorkSession } from '@parley/core';
import type { GroupNode, TabSpec } from '../../shared/layout-types.js';
import type { ParleyBridge } from '../../shared/bridge.js';
import { S } from '../../shared/strings.js';
import { FileBody } from '../files/editor/FileBody.js';
import { workKey as workKeyOf } from '../lib/tree-order.js';
import { ErrorBoundary } from '../shell/ErrorBoundary.js';
import type { SendWithToastDeps } from '../terminal/send.js';
import { BrowserBody } from './bodies/BrowserBody.js';
import { DiffBody } from './bodies/DiffBody.js';
import { MailBody } from './bodies/MailBody.js';
import { MissingBody } from './bodies/MissingBody.js';
import { RoomBody } from './bodies/RoomBody.js';
import { TerminalBody } from './bodies/TerminalBody.js';
import { dndId, type DropTargetData } from './dnd.js';
import { DropIndicator, useBodyDropPreview } from './DropIndicator.js';
import { TabStrip } from './TabStrip.js';
import { useLayoutStore } from './store.js';
import { focusGroup } from './tree.js';

export interface LayoutBodyContextValue {
  bridge: ParleyBridge;
  fontFamily: string;
  fontSize: number;
  /**
   * Работа активна (кусок 2.5): у неактивной работы LRU единственная группа
   * не порталит строку вкладок в `#titlebar-tabs` — там строка только
   * активной работы.
   */
  active: boolean;
  /** Отправка агенту окна (7.2): из `AppShell` через `LayoutView` — заметкам вкладки диффа (8.4b). */
  sendDeps: SendWithToastDeps;
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

/** Отдельный компонент, а не просто функция в теле `GroupView`: бросок должен случиться ВНУТРИ дерева `ErrorBoundary`, иначе граница ошибки его не поймает. */
function TabBody({ tab, entry, host, onMissing }: TabBodyProps): JSX.Element {
  switch (tab.kind) {
    case 'terminal': {
      const session = entry.map.sessions.find((candidate) => candidate.id === tab.sessionId);
      if (session === undefined) return <MissingBody kind="session" onClose={onMissing} />;
      // Сам терминал — в слое поверхностей (`SurfaceLayer.tsx`, кусок 2.5); вид «Chat» — в теле.
      return (
        <TerminalBody
          workKey={workKeyOf(entry.projectPath, entry.map.work.id)}
          tab={tab}
          session={session}
          sessionRef={{ projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: tab.sessionId }}
          active={host.active}
        />
      );
    }
    case 'mail':
      return <MailBody bridge={host.bridge} entry={entry} active={host.active} />;
    case 'room': {
      const room = entry.map.rooms.find((candidate) => candidate.id === tab.roomId);
      if (room === undefined) return <MissingBody kind="room" onClose={onMissing} />;
      return <RoomBody bridge={host.bridge} entry={entry} roomId={tab.roomId} active={host.active} />;
    }
    case 'diff': {
      const session: WorkSession | undefined = entry.map.sessions.find((candidate) => candidate.id === tab.sessionId);
      if (session === undefined) return <MissingBody kind="session" onClose={onMissing} />;
      return (
        <DiffBody
          bridge={host.bridge}
          workKey={workKeyOf(entry.projectPath, entry.map.work.id)}
          entry={entry}
          tab={tab}
          font={{ family: host.fontFamily, size: host.fontSize }}
          sendDeps={host.sendDeps}
        />
      );
    }
    case 'file':
      return (
        <FileBody
          bridge={host.bridge}
          workKey={workKeyOf(entry.projectPath, entry.map.work.id)}
          entry={entry}
          tab={tab}
          onClose={onMissing}
          font={{ family: host.fontFamily, size: host.fontSize }}
        />
      );
    case 'browser':
      // Страница и её строка — в слое поверхностей (`BrowserSurface.tsx`, кусок 9.2a).
      return <BrowserBody />;
  }
}

/**
 * Индикатор тела — отдельный компонент (раунд исправлений 1, ревью A): смена
 * зоны броска перерисовывает только его, а не группу вместе со строкой вкладок.
 */
function BodyDropIndicator({ workKey, groupId }: { workKey: string; groupId: string }): JSX.Element | null {
  const target = useBodyDropPreview(workKey, groupId);
  return target === null ? null : <DropIndicator edge={target === 'center' ? null : target} />;
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
        <BodyDropIndicator workKey={workKey} groupId={group.id} />
        {group.tabs.length === 0 ? (
          // «No open tabs» (спека окна 2026-09-29, 1.8): заголовок Caprasimo 25 и подсказка, слева вверху
          // листа — отступ 56 48, зазор 8.
          <div className="flex h-full flex-col gap-2 px-12 py-14">
            <h3 className="m-0 font-heading text-[25px] leading-[1.12] tracking-[-0.015em]">{S.tabs.noOpenTabs}</h3>
            <p className="m-0 text-sm text-muted-foreground">{S.tabs.emptyGroup}</p>
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
