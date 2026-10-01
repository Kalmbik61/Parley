/**
 * Раскладка активной работы (кусок 2.4, спека 5.1–5.3): дерево сплитов из
 * групп вкладок (`AppShell.tsx` решает, когда её монтировать — при
 * `activeWorkKey === null` `LayoutView` вовсе не в дереве).
 * `bridge`/`fontFamily`/`fontSize` приходят пропами и раздаются телам вкладок
 * контекстом (`GroupView.tsx#LayoutBodyContext`).
 *
 * Клавиш у раскладки нет (кусок 6.1b): ⌃Tab, ⌃1–9 и ⌘⇧[ ] ловит обработчик окна
 * (`keys/handler.ts`) один на окно и бьёт ими по раскладке активной работы.
 */

import type { ParleyBridge } from '../../shared/bridge.js';
import type { SendWithToastDeps } from '../terminal/send.js';
import { workKey as workKeyOf } from '../lib/tree-order.js';
import { useWorksStore } from '../store/works.js';
import { LayoutBodyContext } from './GroupView.js';
import { NodeView } from './SplitView.js';
import { useLayoutStore } from './store.js';
import { groups } from './tree.js';

export interface LayoutViewProps {
  workKey: string;
  /**
   * Работа активна (кусок 2.5): контейнеры трёх работ LRU смонтированы разом,
   * а строка вкладок в заголовке — только у активной.
   */
  active: boolean;
  bridge: ParleyBridge;
  fontFamily: string;
  fontSize: number;
  /** Отправка агенту окна (7.2) — телам вкладок через контекст: заметкам диффа (8.4b). */
  sendDeps: SendWithToastDeps;
}

export function LayoutView({ workKey, active, bridge, fontFamily, fontSize, sendDeps }: LayoutViewProps): JSX.Element | null {
  const layout = useLayoutStore((state) => state.layouts[workKey]);
  const entries = useWorksStore((state) => state.entries);
  const entry = entries.find((item) => workKeyOf(item.projectPath, item.map.work.id) === workKey);

  // Раскладка ещё не гидрирована (`layout/persistence.ts`, доля кадра сразу
  // после смены активной работы) или сама работа уже пропала из снимка —
  // молчаливо ничего не показываем, не «Workspace closed»: это переходное
  // состояние, а не ошибка (следующий снимок либо принесёт работу, либо
  // `AppShell` вовсе уберёт эту работу из активных).
  if (entry === undefined || layout === undefined) return null;

  const singleGroup = groups(layout).length === 1;

  return (
    <LayoutBodyContext.Provider value={{ bridge, fontFamily, fontSize, active, sendDeps }}>
      <div className="flex h-full min-h-0 min-w-0 flex-1">
        <NodeView workKey={workKey} node={layout.root} entry={entry} singleGroup={singleGroup} />
      </div>
    </LayoutBodyContext.Provider>
  );
}
