/**
 * Вкладка «Agents» правого сайдбара (спека 2026-10-07, 5.1): агенты сессии `focusedSessionOf` — работающие с текущим
 * шагом, ниже свёрнутое «Finished (n)». У сессии с видом Chat панель сама держит подписку на её ленту (`FeedSubscription`;
 * подписки со счётчиком) и строит строки по карточкам `agent`; клик по строке — экран агента (выбор в `ui-store.ts`).
 * У сессии без вида Chat — список из `LiveMetrics.tasks` без провала внутрь.
 */

import { Bot, ChevronRight, LoaderCircle } from 'lucide-react';
import type { FeedItem, WorkEntry } from '@parley/core';
import { refKey, type LiveTask, type SessionRef } from '@parley/protocol';
import type { ParleyBridge } from '../../shared/bridge.js';
import { S } from '../../shared/strings.js';
import { FeedSubscription, useFeed } from '../chat/use-feed.js';
import { useChatUiStore } from '../chat/ui-store.js';
import { focusedSessionOf, useLayoutStore } from '../layout/store.js';
import { useFeedAvailability } from '../lib/feed-view.js';
import { formatDuration } from '../lib/metrics-line.js';
import { workKey as workKeyOf } from '../lib/tree-order.js';
import { useNow } from '../lib/use-now.js';
import { useActivityStore } from '../store/activity.js';
import { AgentDetail } from './AgentDetail.js';
import { agentRows, type AgentRow } from './agents-model.js';

export interface AgentsPanelProps {
  bridge: ParleyBridge;
  entry: WorkEntry;
}

export function AgentsPanel({ bridge, entry }: AgentsPanelProps): JSX.Element {
  const workKey = workKeyOf(entry.projectPath, entry.map.work.id);
  const sessionId = useLayoutStore((state) => focusedSessionOf(state, workKey));
  const availability = useFeedAvailability();
  const byRef = useActivityStore((state) => state.byRef);
  const session = sessionId === null ? undefined : entry.map.sessions.find((candidate) => candidate.id === sessionId);
  if (session === undefined) {
    return (
      <div data-testid="agents-panel" className="px-1 text-sm text-muted-foreground">
        {S.agentsPanel.noSession}
      </div>
    );
  }
  const sessionRef: SessionRef = { projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: session.id };
  const tasks = session.lifecycle === 'active' ? (byRef[refKey(sessionRef)]?.metrics?.tasks ?? []) : [];
  return (
    <AgentsPanelView
      key={session.id}
      bridge={bridge}
      sessionRef={sessionRef}
      hasFeed={availability(session.provider) === true}
      tasks={tasks}
    />
  );
}

export interface AgentsPanelViewProps {
  bridge: ParleyBridge;
  sessionRef: SessionRef;
  hasFeed: boolean;
  tasks: readonly LiveTask[];
}

export function AgentsPanelView({ bridge, sessionRef, hasFeed, tasks }: AgentsPanelViewProps): JSX.Element {
  const key = refKey(sessionRef);
  const feed = useFeed(sessionRef);
  const finishedOpen = useChatUiStore((state) => state.finishedOpen[key] ?? false);
  const select = useChatUiStore((state) => state.selectAgent);
  const pick = useChatUiStore((state) => state.agentPanel[key] ?? null);

  if (!hasFeed) {
    return (
      <div data-testid="agents-panel" className="flex min-h-0 flex-col gap-2 overflow-y-auto px-1">
        {tasks.length === 0 ? <p className="text-sm text-muted-foreground">{S.agentsPanel.empty}</p> : null}
        {tasks.map((task) => (
          <div key={task.id} className="flex min-w-0 items-center gap-2 text-sm">
            <Bot className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 truncate">{task.description ?? task.agentType ?? S.chat.agent.fallbackTitle}</span>
          </div>
        ))}
        <p className="text-xs text-muted-foreground">{S.agentsPanel.needsChat}</p>
      </div>
    );
  }

  // Подписка — первым ребёнком при обоих видах: переход список ↔ экран агента её не пересоздаёт.
  return (
    <>
      <FeedSubscription sessionRef={sessionRef} />
      {pick !== null ? (
        <div data-testid="agents-panel" className="flex min-h-0 flex-col">
          <AgentDetail bridge={bridge} sessionRef={sessionRef} items={feed?.items ?? []} pick={pick} onBack={() => select(key, null)} />
        </div>
      ) : (
        <AgentList feedItems={feed?.items ?? []} sessionKey={key} finishedOpen={finishedOpen} />
      )}
    </>
  );
}

function AgentList({ feedItems, sessionKey: key, finishedOpen }: { feedItems: readonly FeedItem[]; sessionKey: string; finishedOpen: boolean }): JSX.Element {
  const select = useChatUiStore((state) => state.selectAgent);
  const setFinishedOpen = useChatUiStore((state) => state.setFinishedOpen);
  const { running, finished } = agentRows(feedItems);
  return (
    <div data-testid="agents-panel" className="flex min-h-0 flex-col gap-1 overflow-y-auto px-1">
      {running.length === 0 && finished.length === 0 ? <p className="text-sm text-muted-foreground">{S.agentsPanel.empty}</p> : null}
      {running.map((row) => (
        <AgentRowButton key={row.itemId} row={row} testId="agents-row-running" onOpen={() => select(key, { by: 'item', id: row.itemId })} />
      ))}
      {finished.length > 0 ? (
        <button
          type="button"
          aria-expanded={finishedOpen}
          className="mt-2 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setFinishedOpen(key, !finishedOpen)}
        >
          <ChevronRight className={finishedOpen ? 'size-3 rotate-90' : 'size-3'} aria-hidden="true" />
          {S.agentsPanel.finished(finished.length)}
        </button>
      ) : null}
      {finishedOpen
        ? finished.map((row) => (
            <AgentRowButton key={row.itemId} row={row} testId="agents-row-finished" onOpen={() => select(key, { by: 'item', id: row.itemId })} />
          ))
        : null}
    </div>
  );
}

function AgentRowButton({ row, testId, onOpen }: { row: AgentRow; testId: string; onOpen: () => void }): JSX.Element {
  const now = useNow(1000);
  const running = row.status === 'running';
  const elapsed = running ? now.getTime() - Date.parse(row.startedAt) : row.durationMs;
  const step = row.agentId === null ? S.agentsPanel.starting : row.step === null ? S.agentsPanel.thinking : (row.step.summary ?? row.step.name);
  const meta = [row.type, row.model, S.chat.agent.toolCalls(row.toolCount), formatDuration(elapsed)].filter((part) => part !== null && part !== '');
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onOpen}
      className="flex w-full min-w-0 flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left hover:bg-foreground/7"
    >
      <span className="flex min-w-0 items-center gap-1.5 text-sm">
        {running ? <LoaderCircle className="size-3.5 shrink-0 animate-spin" aria-hidden="true" /> : <Bot className="size-3.5 shrink-0" aria-hidden="true" />}
        <span className="min-w-0 truncate font-medium">{row.title ?? S.chat.agent.fallbackTitle}</span>
      </span>
      <span className="min-w-0 truncate text-xs text-muted-foreground">{step}</span>
      <span className="min-w-0 truncate text-[11px] text-muted-foreground">{meta.join(' · ')}</span>
    </button>
  );
}
