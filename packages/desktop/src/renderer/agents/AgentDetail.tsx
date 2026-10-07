// packages/desktop/src/renderer/agents/AgentDetail.tsx
/**
 * Экран агента в панели Agents (спека 2026-10-07, 5.1): шапка (описание, тип · модель, статус, время), задание
 * Markdown (длиннее 12 строк — свёрнуто), этапы (`agentSteps`), вызовы вживую компактными строками, итог, полный
 * транскрипт (`chat/transcript.ts`, живое обновление) и «Show in chat». Агент ищется в ленте по выбору (`AgentPick`)
 * на каждом рендере — поэтому экран живой и переживает конец агента.
 */

import { useState } from 'react';
import { ArrowLeft, CheckCircle2, Circle, LoaderCircle } from 'lucide-react';
import type { FeedItem } from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import type { ParleyBridge } from '../../shared/bridge.js';
import { S } from '../../shared/strings.js';
import { ChatEnvContext } from '../chat/chat-env.js';
import { ToolItem } from '../chat/items/ToolItem.js';
import { openAgentCard } from '../chat/open-agent.js';
import { requestTranscript, TRANSCRIPT_TAIL, useLiveTranscript, type Transcript } from '../chat/transcript.js';
import { RoomMarkdown } from '../components/rooms/RoomMarkdown.js';
import { formatDuration } from '../lib/metrics-line.js';
import { useNow } from '../lib/use-now.js';
import { agentSteps, findAgent, type AgentPick } from './agents-model.js';

const PROMPT_LINES = 12;
const noLabel = (): null => null;

export interface AgentDetailProps {
  bridge: ParleyBridge;
  sessionRef: SessionRef;
  items: readonly FeedItem[];
  pick: AgentPick;
  onBack: () => void;
}

export function AgentDetail({ bridge, sessionRef, items, pick, onBack }: AgentDetailProps): JSX.Element {
  const agent = findAgent(items, pick);
  const [promptOpen, setPromptOpen] = useState(false);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const now = useNow(1000);
  const reload = (): void => {
    if (agent?.agentId != null) requestTranscript(bridge, sessionRef, agent.agentId, setTranscript);
  };
  useLiveTranscript(agent ?? { agentId: null, status: 'done', toolCount: 0 }, transcript !== null, reload);

  const back = (
    <button type="button" onClick={onBack} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
      <ArrowLeft className="size-3" aria-hidden="true" />
      {S.agentsPanel.back}
    </button>
  );
  if (agent === null) {
    return (
      <div data-testid="agent-detail" className="flex flex-col gap-2 px-1">
        {back}
        <p className="text-sm text-muted-foreground">{S.agentsPanel.gone}</p>
      </div>
    );
  }

  const running = agent.status === 'running';
  const elapsed = running ? now.getTime() - Date.parse(agent.at) : (agent.durationMs ?? null);
  const promptLines = (agent.prompt ?? '').split('\n');
  const prompt = promptOpen || promptLines.length <= PROMPT_LINES ? agent.prompt ?? '' : promptLines.slice(0, PROMPT_LINES).join('\n');
  const steps = agentSteps(agent);
  const tail = transcript?.state === 'ready' ? transcript.items.slice(-TRANSCRIPT_TAIL) : [];

  return (
    <ChatEnvContext.Provider value={{ bridge, sessionRef }}>
      <div data-testid="agent-detail" className="flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto px-1 pb-2">
        {back}
        <header className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
            {running ? <LoaderCircle className="size-3.5 shrink-0 animate-spin" aria-hidden="true" /> : null}
            <span className="min-w-0 truncate">{agent.description ?? agent.agentType ?? S.chat.agent.fallbackTitle}</span>
          </span>
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {[agent.agentType, agent.model, S.chat.agent.status[agent.status], formatDuration(elapsed)].filter(Boolean).join(' · ')}
          </span>
        </header>

        {agent.prompt !== null ? (
          <section className="flex min-w-0 flex-col gap-1">
            <h3 className="text-xs font-semibold uppercase text-muted-foreground">{S.agentsPanel.task}</h3>
            <div className="min-w-0 break-words text-sm">
              <RoomMarkdown text={prompt} labelOf={noLabel} onOpenExternal={(url) => void bridge.app.openExternal(url)} />
            </div>
            {promptLines.length > PROMPT_LINES ? (
              <button type="button" className="self-start text-xs text-muted-foreground hover:text-foreground" onClick={() => setPromptOpen(!promptOpen)}>
                {promptOpen ? S.agentsPanel.showLess : S.agentsPanel.showAll}
              </button>
            ) : null}
          </section>
        ) : null}

        {steps !== null ? (
          <section className="flex min-w-0 flex-col gap-1">
            <h3 className="text-xs font-semibold uppercase text-muted-foreground">{S.agentsPanel.steps}</h3>
            <ul className="flex flex-col gap-0.5 text-sm">
              {steps.map((step, index) => (
                <li key={index} className="flex min-w-0 items-start gap-1.5">
                  {step.status === 'completed' ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" /> : step.status === 'in_progress' ? <LoaderCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" /> : <Circle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />}
                  <span className="min-w-0 break-words">{step.text}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="flex min-w-0 flex-col gap-1">
          <h3 className="text-xs font-semibold uppercase text-muted-foreground">{S.agentsPanel.activity}</h3>
          {agent.children.length === 0 ? <p className="text-xs text-muted-foreground">{S.agentsPanel.noActivity}</p> : null}
          {agent.children.map((child) => (
            <ToolItem key={child.id} item={child} compact />
          ))}
        </section>

        {agent.result !== undefined ? (
          <section className="flex min-w-0 flex-col gap-1">
            <h3 className="text-xs font-semibold uppercase text-muted-foreground">{S.agentsPanel.result}</h3>
            <div className="min-w-0 break-words text-sm">
              <RoomMarkdown text={agent.result} labelOf={noLabel} onOpenExternal={(url) => void bridge.app.openExternal(url)} />
            </div>
          </section>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {agent.agentId !== null ? (
            <button type="button" className="text-xs underline-offset-2 hover:underline" onClick={() => (transcript === null ? reload() : setTranscript(null))}>
              {transcript === null ? S.agentsPanel.fullTranscript : S.agentsPanel.hideTranscript}
            </button>
          ) : null}
          {agent.agentId !== null ? (
            <button type="button" className="text-xs underline-offset-2 hover:underline" onClick={() => openAgentCard(sessionRef, agent.agentId as string)}>
              {S.agentsPanel.showInChat}
            </button>
          ) : null}
        </div>
        {transcript?.state === 'loading' ? <p className="text-xs text-muted-foreground">{S.chat.agent.transcriptLoading}</p> : null}
        {transcript?.state === 'error' ? <p className="text-xs text-muted-foreground">{S.chat.agent.transcriptFailed}</p> : null}
        {tail.map((item) => (item.kind === 'tool' ? <ToolItem key={item.id} item={item} compact /> : item.kind === 'text' || item.kind === 'prompt' ? (
          <div key={item.id} className="min-w-0 break-words text-sm"><RoomMarkdown text={item.text} labelOf={noLabel} onOpenExternal={(url) => void bridge.app.openExternal(url)} /></div>
        ) : null))}
      </div>
    </ChatEnvContext.Provider>
  );
}
