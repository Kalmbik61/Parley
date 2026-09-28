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

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef } from 'react';
import { useDroppable } from '@dnd-kit/core';
import type { WorkEntry, WorkSession } from '@harnas/core';
import type { SessionRef } from '@harnas/protocol';
import type { GroupNode, TabSpec } from '../../shared/layout-types.js';
import type { HarnasBridge } from '../../shared/bridge.js';
import type { FileRoot } from '../../shared/files-types.js';
import { errorText, S } from '../../shared/strings.js';
import { rootKey } from '../../shared/work-keys.js';
import { bufferKey } from '../files/buffer.js';
import { useFilesStore } from '../files/store.js';
import { workKey as workKeyOf } from '../lib/tree-order.js';
import { ErrorBoundary } from '../shell/ErrorBoundary.js';
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

/**
 * Больше стольких символов временное тело не показывает: `<pre>` на 20 МБ (предел `readText`)
 * подвесил бы окно, а редактор с пределами спеки 10.4 придёт в 7.3b.
 */
const FILE_TEXT_LIMIT = 2 * 1024 * 1024;

/**
 * Временное тело вкладки `file` (куски 7.2, 7.3a): буфер стора (`files/store.ts`) в простом поле
 * ввода, чтобы правка жила с вкладкой, а не с телом. 7.3b меняет его на `FileBody` с Monaco,
 * баннером и ⌘S. Только чтение (больше 2 МБ, не UTF-8) — `<pre>`. Отказ —
 * `errorText(code, S.errors.actions.openFile)`, `files:denied` — `S.files.denied`: кодов `files:*`
 * `errorText` не знает.
 */
function FileTextBody({ bridge, workKey, tabId, root, path }: { bridge: HarnasBridge; workKey: string; tabId: string; root: FileRoot; path: string }): JSX.Element {
  const key = bufferKey(workKey, tabId);
  const model = useFilesStore((state) => state.buffers[key]?.model ?? null);
  const rootId = rootKey(root);
  useEffect(() => {
    // Повтор для перемонтированного тела ничего не делает: буфер уже в сторе.
    useFilesStore.getState().openBuffer(bridge, workKey, tabId, root, path);
    // Корень — в `rootId`: объект `root` новый на каждую отрисовку группы.
  }, [bridge, workKey, tabId, rootId, path]);
  if (model === null || model.status === 'loading') return <div className="h-full" />;
  if (model.status === 'error') {
    const code = model.errorCode ?? 'failed';
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
        {code === 'files:denied' ? S.files.denied : errorText(code, S.errors.actions.openFile)}
      </div>
    );
  }
  if (model.readOnlyReason !== null) {
    return (
      <pre data-testid="file-text" className="h-full overflow-auto whitespace-pre p-3 font-mono text-xs text-foreground">
        {model.text.length > FILE_TEXT_LIMIT ? model.text.slice(0, FILE_TEXT_LIMIT) : model.text}
      </pre>
    );
  }
  return (
    <textarea
      data-testid="file-text"
      aria-label={path}
      spellCheck={false}
      value={model.text}
      onChange={(event) => useFilesStore.getState().dispatch(key, { type: 'edited', text: event.target.value })}
      className="h-full w-full resize-none whitespace-pre bg-transparent p-3 font-mono text-xs text-foreground outline-none"
    />
  );
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
      return <MailBody bridge={host.bridge} entry={entry} active={host.active} />;
    case 'room': {
      const room = entry.map.rooms.find((candidate) => candidate.id === tab.roomId);
      if (room === undefined) return <MissingBody kind="room" onClose={onMissing} />;
      return <RoomBody bridge={host.bridge} entry={entry} roomId={tab.roomId} active={host.active} />;
    }
    case 'diff': {
      const session: WorkSession | undefined = entry.map.sessions.find((candidate) => candidate.id === tab.sessionId);
      if (session === undefined) return <MissingBody kind="session" onClose={onMissing} />;
      return <DiffBody bridge={host.bridge} sessionRef={refOf(entry, tab.sessionId)} session={session} />;
    }
    case 'file': {
      const key = workKeyOf(entry.projectPath, entry.map.work.id);
      return <FileTextBody bridge={host.bridge} workKey={key} tabId={tab.id} root={{ workKey: key, spec: tab.root }} path={tab.path} />;
    }
    case 'browser':
      // Вкладка браузера появится в этапе 9 — открыть её пока неоткуда, сюда не
      // дойти; `ErrorBoundary` вокруг ловит бросок, если это всё же случится.
      throw new Error(`GroupView: tab kind "${tab.kind}" is not available yet`);
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
