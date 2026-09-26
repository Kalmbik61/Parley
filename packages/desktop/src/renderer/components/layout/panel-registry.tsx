/**
 * Компоненты содержимого панелей dockview по виду (кусок 2.1 плана окна,
 * спека 4.4). Терминал — из этапа 1 (`TerminalPanel.tsx`); почта, комната,
 * изменения — заглушки до кусков 2.4, 3.6, 4.3.
 *
 * Файл заведён как `.tsx`, а не `.ts` из интерфейсов куска: компоненты — JSX,
 * а в этом проекте JSX-синтаксис разрешён только в `.tsx` (`tsconfig.web.json`
 * → `"jsx": "react-jsx"`, обычная настройка TypeScript). Публичный экспорт
 * (`PANEL_COMPONENTS`) — тот же, что описан в плане.
 *
 * `bridge`/тема/шрифт терминалу нужны реальные (не через `params`, в которых
 * лежит только адрес панели) — `PanelHostContext` их даёт панелям сетки так
 * же, как раньше их получал единственный `TerminalPanel` в `App.tsx`.
 */

import { createContext, useContext, useEffect, useState, type FC } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { refKey } from '@harnas/protocol';
import type { HarnasBridge } from '../../../shared/bridge.js';
import { TerminalPanel } from '../terminal/TerminalPanel.js';
import { useUiStore } from '../../store/ui.js';
import type { PanelSpec } from '../../lib/panel-id.js';

export interface PanelHostContextValue {
  bridge: HarnasBridge;
  theme: string;
  fontFamily: string;
  fontSize: number;
}

export const PanelHostContext = createContext<PanelHostContextValue | null>(null);

function usePanelHost(): PanelHostContextValue {
  const value = useContext(PanelHostContext);
  if (value === null) throw new Error('панель dockview вне PanelHostContext (Workspace должен его выставлять)');
  return value;
}

function TerminalPanelContent({ api, params }: IDockviewPanelProps<PanelSpec>): JSX.Element {
  const host = usePanelHost();
  // `isActive` — активная ли это вкладка своей группы прямо сейчас: ровно то,
  // что план называет «видна» (тест 5а куска 2.1). Значение читается заново
  // при монтировании на случай, если панель родилась уже неактивной.
  const [visible, setVisible] = useState(api.isActive);

  if (params.ref === undefined) throw new Error('panel-registry: панель terminal без ref');
  const ref = params.ref;

  useEffect(() => {
    // `visibleSessionRefs` в `store/ui.ts` — общий регистр для уведомлений
    // (`App.tsx#wireNotifications`): в отличие от `visible` выше (эта одна
    // панель), там нужны видимые панели ВСЕХ групп сразу.
    const key = refKey(ref);
    useUiStore.getState().setSessionVisible(key, api.isActive);
    const subscription = api.onDidActiveChange(({ isActive }) => {
      setVisible(isActive);
      useUiStore.getState().setSessionVisible(key, isActive);
    });
    return () => {
      subscription.dispose();
      useUiStore.getState().setSessionVisible(key, false);
    };
  }, [api, ref]);

  return (
    <TerminalPanel
      bridge={host.bridge}
      sessionRef={ref}
      theme={host.theme}
      fontFamily={host.fontFamily}
      fontSize={host.fontSize}
      visible={visible}
    />
  );
}

function placeholder(text: string): FC<IDockviewPanelProps<PanelSpec>> {
  return function PlaceholderPanel() {
    return <div className="flex h-full items-center justify-center text-sm text-[var(--h-muted)]">{text}</div>;
  };
}

export const PANEL_COMPONENTS: Record<PanelSpec['kind'], FC<IDockviewPanelProps<PanelSpec>>> = {
  terminal: TerminalPanelContent,
  mail: placeholder('Вся почта работы — скоро (кусок 2.4)'),
  room: placeholder('Комната — скоро (кусок 3.6)'),
  changes: placeholder('Изменения — скоро (кусок 4.3)'),
};
