/**
 * Тело вкладки терминала (кусок 2.5, спека 5.5): пустое место-заглушка. Сам
 * терминал живёт в слое поверхностей работы (`layout/SurfaceLayer.tsx`) и
 * привязан CSS-якорем к телу группы (`GroupView.tsx`, `--g-<groupId>`) —
 * поэтому перенос вкладки между группами не пересоздаёт xterm.
 *
 * Вид «Chat» (план 2026-10-01, решение 6): при эффективном виде `chat` тело рисует `ChatView`, а
 * поверхности терминала у вкладки нет. В виде терминала, когда хост знает ленту, сверху — тулбар
 * с сегментом «Chat | Terminal», а поверхность опускается под него (`TAB_TOOLBAR_PX`). Пока доступность
 * вида неизвестна (версия `claude` ещё не пришла), тело — пустая заглушка, а слой поверхностей не
 * монтирует ни терминал, ни подписку на ленту.
 */

import type { WorkSession } from '@parley/core';
import { refKey, type SessionRef } from '@parley/protocol';
import type { ParleyBridge } from '../../../shared/bridge.js';
import { ChatToolbar } from '../../chat/ChatToolbar.js';
import { ChatView } from '../../chat/ChatView.js';
import { effectiveView, useFeedAvailability, useHostHasFeed, useSessionStarted, type TerminalTab } from '../../lib/feed-view.js';
import type { SendWithToastDeps } from '../../terminal/send.js';

export interface TerminalBodyProps {
  workKey: string;
  tab: TerminalTab;
  session: WorkSession;
  sessionRef: SessionRef;
  /** Работа активна (`LayoutBodyContext.active`). */
  active: boolean;
  bridge: ParleyBridge;
  sendDeps: SendWithToastDeps;
}

export function TerminalBody({ workKey, tab, session, sessionRef, active, bridge, sendDeps }: TerminalBodyProps): JSX.Element {
  const hasFeed = useHostHasFeed();
  const available = useFeedAvailability()(session.provider);
  const started = useSessionStarted(sessionRef);
  const view = effectiveView(tab, available, started);
  if (view === null) return <div data-testid="tab-view-pending" className="h-full w-full" />;
  if (view === 'chat') {
    return (
      <ChatView
        workKey={workKey}
        tab={tab}
        sessionRef={sessionRef}
        visible={active}
        live={session.lifecycle === 'active'}
        bridge={bridge}
        sendDeps={sendDeps}
        provider={session.provider}
        storedModel={session.model ?? null}
        storedEffort={session.effort ?? null}
      />
    );
  }
  return (
    <div data-testid="terminal-body" className="flex h-full w-full flex-col">
      {hasFeed ? <ChatToolbar workKey={workKey} tabId={tab.id} view="terminal" available={available === true} micTargetId={`terminal:${refKey(sessionRef)}`} /> : null}
    </div>
  );
}
