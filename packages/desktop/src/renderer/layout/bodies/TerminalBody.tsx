/**
 * Тело вкладки терминала (кусок 2.5, спека 5.5): пустое место-заглушка. Сам
 * терминал живёт в слое поверхностей работы (`layout/SurfaceLayer.tsx`) и
 * привязан CSS-якорем к телу группы (`GroupView.tsx`, `--g-<groupId>`) —
 * поэтому перенос вкладки между группами не пересоздаёт xterm.
 *
 * Вид «Chat» (план 2026-10-01, решение 6): при эффективном виде `chat` тело рисует `ChatView`, а
 * поверхности терминала у вкладки нет. В виде терминала, когда хост знает ленту, сверху — тулбар
 * с сегментом «Chat | Terminal», а поверхность опускается под него (`TAB_TOOLBAR_PX`).
 */

import type { WorkSession } from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import { ChatToolbar } from '../../chat/ChatToolbar.js';
import { ChatView } from '../../chat/ChatView.js';
import { effectiveView, useFeedAvailability, useHostHasFeed, type TerminalTab } from '../../lib/feed-view.js';

export interface TerminalBodyProps {
  workKey: string;
  tab: TerminalTab;
  session: WorkSession;
  sessionRef: SessionRef;
  /** Работа активна (`LayoutBodyContext.active`). */
  active: boolean;
}

export function TerminalBody({ workKey, tab, session, sessionRef, active }: TerminalBodyProps): JSX.Element {
  const hasFeed = useHostHasFeed();
  const available = useFeedAvailability()(session.provider);
  if (effectiveView(tab, available) === 'chat') {
    return <ChatView workKey={workKey} tab={tab} sessionRef={sessionRef} visible={active} />;
  }
  return (
    <div data-testid="terminal-body" className="flex h-full w-full flex-col">
      {hasFeed ? <ChatToolbar workKey={workKey} tabId={tab.id} view="terminal" available={available} /> : null}
    </div>
  );
}
