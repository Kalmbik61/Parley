/**
 * Компоненты содержимого панелей dockview по виду (кусок 2.1 плана окна,
 * спека 4.4). Терминал — из этапа 1 (`TerminalPanel.tsx`); почта — из куска
 * 2.4 (`MailPanel.tsx`); комната, изменения — заглушки до кусков 3.6, 4.3.
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
import { refKey, type SessionRef } from '@harnas/protocol';
import type { HarnasBridge } from '../../../shared/bridge.js';
import { TerminalPanel } from '../terminal/TerminalPanel.js';
import { MailPanel } from '../mail/MailPanel.js';
import { activityFor, useActivityStore } from '../../store/activity.js';
import { useUiStore } from '../../store/ui.js';
import { useWorksStore } from '../../store/works.js';
import type { PanelSpec } from '../../lib/panel-id.js';
import { workKey } from '../../lib/tree-order.js';

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
  // «Видна» (тест 5а куска 2.1) — это `isVisible`: активная вкладка своей
  // группы. `isActive` у dockview один на всё окно — с ним соседние группы
  // отключались от потока и переставали показывать вывод агента.
  const [visible, setVisible] = useState(api.isVisible);

  if (params.ref === undefined) throw new Error('panel-registry: панель terminal без ref');
  const ref = params.ref;

  useEffect(() => {
    // `visibleSessionRefs` в `store/ui.ts` — общий регистр для уведомлений
    // (`App.tsx#wireNotifications`): в отличие от `visible` выше (эта одна
    // панель), там нужны видимые панели ВСЕХ групп сразу.
    const key = refKey(ref);
    useUiStore.getState().setSessionVisible(key, api.isVisible);
    const subscription = api.onDidVisibilityChange(({ isVisible }) => {
      setVisible(isVisible);
      useUiStore.getState().setSessionVisible(key, isVisible);
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

/**
 * Панель «вся почта работы»: сама берёт свежую работу из `store/works.ts` по
 * `params.workKey`, а не через `params` — dockview кладёт туда снимок на
 * момент открытия панели, письма же приходят позже теми же событиями хоста,
 * что и весь остальной сайдбар.
 */
function MailPanelContent({ params }: IDockviewPanelProps<PanelSpec>): JSX.Element {
  const host = usePanelHost();
  const entries = useWorksStore((state) => state.entries);
  const activityByRef = useActivityStore((state) => state.byRef);
  const [providers, setProviders] = useState<Array<{ id: string; label: string }>>([]);

  useEffect(() => {
    // Список провайдеров почти не меняется за сеанс — один запрос при
    // монтировании панели достаточен (тот же приём, что и в `NewSessionDialog.tsx`).
    host.bridge
      .call('providers.list', {})
      .then((result) => setProviders(result.providers))
      .catch(() => {});
  }, [host.bridge]);

  const entry = entries.find((item) => workKey(item.projectPath, item.map.work.id) === params.workKey);
  if (entry === undefined) {
    return <div className="flex h-full items-center justify-center text-sm text-[var(--h-muted)]">Работа закрыта</div>;
  }

  // `LiveMetrics.model` — единственный источник имени модели у рендерера
  // (`participantTag` из ядра тянуть нельзя, см. `lib/participant-tag.ts`).
  const models: Record<string, string | null> = {};
  for (const session of entry.map.sessions) {
    const ref: SessionRef = { projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: session.id };
    models[session.id] = activityFor(activityByRef, ref)?.metrics?.model ?? null;
  }

  return (
    <MailPanel
      entry={entry}
      providers={providers}
      models={models}
      onOpenExternal={(url) => void host.bridge.app.openExternal(url)}
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
  mail: MailPanelContent,
  room: placeholder('Комната — скоро (кусок 3.6)'),
  changes: placeholder('Изменения — скоро (кусок 4.3)'),
};
