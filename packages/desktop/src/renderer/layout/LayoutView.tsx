/**
 * Раскладка активной работы (кусок 2.4, спека 5.1–5.3): дерево сплитов из
 * групп вкладок (`AppShell.tsx` решает, когда её монтировать — при
 * `activeWorkKey === null` `LayoutView` вовсе не в дереве).
 * `bridge`/`fontFamily`/`fontSize` приходят пропами и раздаются телам вкладок
 * контекстом (`GroupView.tsx#LayoutBodyContext`).
 *
 * Клавиши, которые ловит сам рендерер, а не системное меню (спека 5.3, до
 * реестра клавиш 6.1) — ⌃Tab/⌃⇧Tab (MRU вкладок работы), ⌃1–9 (вкладка по
 * номеру в активной группе), ⌘⇧[/⌘⇧] (соседняя вкладка активной группы) —
 * висят тут. С 2.5 `LayoutView` смонтирован у трёх работ LRU сразу, поэтому
 * слушатель на `window` заводится только при `active` — иначе клавиша била бы
 * по всем трём раскладкам.
 *
 * Раунд исправлений 1 (ревью A, Important №1): ⌃Tab/⌃⇧Tab держат зажатым ⌃, как
 * в VS Code/Orca — повторные `Tab` идут дальше по СНИМКУ MRU, сделанному на
 * первое нажатие (`mruSessionRef`), а не по живому списку. Живой список
 * (`layout/store.ts#updateMru`) всё равно переставляется на КАЖДЫЙ
 * промежуточный `focusTab` (это не в этом кус­ке трогать `store.ts`) — но раз
 * снимок держит СВОЙ порядок в замыкании, эти промежуточные перестановки на
 * навигацию по снимку не влияют. Настоящая перестановка MRU фиксируется только
 * на отпускании ⌃ (`keyup Control`) или при потере фокуса окна — тогда снимок
 * записывается в стор напрямую (`setState`, тот же приём, что и у тестов).
 */

import { useEffect, useRef } from 'react';
import type { HarnasBridge } from '../../shared/bridge.js';
import { workKey as workKeyOf } from '../lib/tree-order.js';
import { useWorksStore } from '../store/works.js';
import { LayoutBodyContext } from './GroupView.js';
import { layoutKeyAction } from './keys.js';
import { NodeView } from './SplitView.js';
import { useLayoutStore } from './store.js';
import { focusTab, groups } from './tree.js';

export interface LayoutViewProps {
  workKey: string;
  /**
   * Работа активна (кусок 2.5): контейнеры трёх работ LRU смонтированы разом,
   * а клавиши 2.4 и строка вкладок в заголовке — только у активной.
   */
  active: boolean;
  bridge: HarnasBridge;
  fontFamily: string;
  fontSize: number;
}

/** Индекс по кругу: `step` может увести и вперёд, и назад за границы массива. */
function wrapIndex(index: number, length: number): number {
  return ((index % length) + length) % length;
}

/** Снимок MRU на первое ⌃Tab и текущая позиция курсора в нём — живёт, пока ⌃ зажат. */
interface MruSession {
  snapshot: readonly string[];
  index: number;
}

export function LayoutView({ workKey, active, bridge, fontFamily, fontSize }: LayoutViewProps): JSX.Element | null {
  const layout = useLayoutStore((state) => state.layouts[workKey]);
  const entries = useWorksStore((state) => state.entries);
  const entry = entries.find((item) => workKeyOf(item.projectPath, item.map.work.id) === workKey);

  const mruSessionRef = useRef<MruSession | null>(null);

  useEffect(() => {
    if (!active) return undefined;
    // Отпускание ⌃ (или потеря фокуса окна) фиксирует итог цикла: снятая
    // вкладка встаёт первой, остальные снимка — следом, в прежнем порядке
    // между собой (та же форма, что `history.ts#touchMru`, только по индексу
    // снимка, а не по живому списку).
    const commitMruSession = (): void => {
      const session = mruSessionRef.current;
      if (session === null) return;
      mruSessionRef.current = null;
      const target = session.snapshot[session.index];
      if (target === undefined) return;
      const rest = session.snapshot.filter((_, index) => index !== session.index);
      useLayoutStore.setState((state) => ({ mru: { ...state.mru, [workKey]: [target, ...rest] } }));
    };

    const handleKeyDown = (event: KeyboardEvent): void => {
      const action = layoutKeyAction(event);
      // `work-step` (⌘⇧↑↓, кусок 3.4) — не этой раскладки: его разбирает `AppShell`, а тут он
      // проходит мимо без `preventDefault` и не листает вкладки.
      if (action === null || action.kind === 'work-step') return;

      const current = useLayoutStore.getState().layouts[workKey];
      if (current === undefined) return;
      const activeGroup = groups(current).find((candidate) => candidate.id === current.activeGroupId);

      if (action.kind === 'mru') {
        let session = mruSessionRef.current;
        if (session === null) {
          const snapshot = useLayoutStore.getState().mru[workKey] ?? [];
          // 0 — сама текущая вкладка (MRU обновляется на каждый фокус, спека
          // 5.7): цикл имеет смысл от двух записей.
          if (snapshot.length < 2) return;
          session = { snapshot, index: 0 };
        }
        session = { snapshot: session.snapshot, index: wrapIndex(session.index + action.step, session.snapshot.length) };
        mruSessionRef.current = session;
        const tabId = session.snapshot[session.index];
        if (tabId !== undefined) useLayoutStore.getState().apply(workKey, (l) => focusTab(l, tabId));
      } else if (action.kind === 'tab-index') {
        const tab = activeGroup?.tabs[action.index];
        if (tab !== undefined) useLayoutStore.getState().apply(workKey, (l) => focusTab(l, tab.id));
      } else if (action.kind === 'tab-step') {
        if (activeGroup === undefined || activeGroup.tabs.length === 0) return;
        const currentIndex = activeGroup.tabs.findIndex((tab) => tab.id === activeGroup.activeTabId);
        const tab = activeGroup.tabs[wrapIndex(currentIndex + action.step, activeGroup.tabs.length)];
        if (tab !== undefined) useLayoutStore.getState().apply(workKey, (l) => focusTab(l, tab.id));
      }
      event.preventDefault();
    };

    const handleKeyUp = (event: KeyboardEvent): void => {
      if (event.key === 'Control') commitMruSession();
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', commitMruSession);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', commitMruSession);
      // Смена активной работы посреди удержания ⌃ — редкий, но реальный
      // случай (клик по карточке сайдбара мышью, не отпуская клавиатуру):
      // снимок следующей работе не принадлежит, отбрасываем его без commit.
      mruSessionRef.current = null;
    };
  }, [workKey, active]);

  // Раскладка ещё не гидрирована (`layout/persistence.ts`, доля кадра сразу
  // после смены активной работы) или сама работа уже пропала из снимка —
  // молчаливо ничего не показываем, не «Workspace closed»: это переходное
  // состояние, а не ошибка (следующий снимок либо принесёт работу, либо
  // `AppShell` вовсе уберёт эту работу из активных).
  if (entry === undefined || layout === undefined) return null;

  const singleGroup = groups(layout).length === 1;

  return (
    <LayoutBodyContext.Provider value={{ bridge, fontFamily, fontSize, active }}>
      <div className="flex h-full min-h-0 min-w-0 flex-1">
        <NodeView workKey={workKey} node={layout.root} entry={entry} singleGroup={singleGroup} />
      </div>
    </LayoutBodyContext.Provider>
  );
}
