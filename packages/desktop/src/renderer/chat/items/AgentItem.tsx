/**
 * Карточка субагента (план 2026-10-01, решение 13). Свёрнуто — значок типа, описание задачи, тип,
 * модель, статус со спиннером, «N tool calls» и длительность (у живого — сколько идёт). Развёрнуто —
 * вложенные вызовы сжатыми строками (приходят живьём дельтами ленты, карточка держит последние 100),
 * итоговый текст Markdown и «Show transcript»: полная лента субагента `feed.snapshot { ref, agentId }`
 * в ту же область (загрузка, ошибка, готово); повторное нажатие её сворачивает. Карточка `running`
 * остаётся живой и после конца хода родителя — пока не придёт `SubagentStop`.
 *
 * Состояние транскрипта (показан, загружен) держит лента по `id` карточки, как и раскрытие: строку вне
 * экрана виртуальный список размонтирует, и загруженный транскрипт иначе пропал бы. Показываются
 * последние `TRANSCRIPT_TAIL` элементов с пометкой — транскрипт в тысячи элементов с Markdown целиком
 * в DOM подвесил бы окно.
 */

import { Bot, ChevronRight, ListChecks, LoaderCircle, Search, type LucideIcon } from 'lucide-react';
import type { FeedAgent, FeedItem } from '@parley/core';
import { decodeIpcError } from '../../../shared/ipc-error.js';
import { S } from '../../../shared/strings.js';
import { RoomMarkdown } from '../../components/rooms/RoomMarkdown.js';
import { cn } from '../../lib/cn.js';
import { formatDuration } from '../../lib/metrics-line.js';
import { useNow } from '../../lib/use-now.js';
import { useChatEnv } from '../chat-env.js';
import { ToolItem } from './ToolItem.js';

const TYPE_ICONS: Record<string, LucideIcon> = { Explore: Search, Plan: ListChecks };

const noLabel = (): null => null;

/** Сколько последних элементов транскрипта субагента показывается. */
export const TRANSCRIPT_TAIL = 200;

export type Transcript = { state: 'loading' } | { state: 'error' } | { state: 'ready'; items: FeedItem[] };

/** Обновление транскрипта карточки; `null` — свёрнут. */
export type TranscriptUpdate = (was: Transcript | null) => Transcript | null;

export interface AgentItemProps {
  item: FeedAgent;
  expanded: boolean;
  onToggle: () => void;
  /** Транскрипт из ленты (по `id` карточки); `null` — не показан. */
  transcript: Transcript | null;
  onTranscript: (update: TranscriptUpdate) => void;
}

/** Живому агенту — секундомер; закончившемуся — его длительность. */
function AgentDuration({ item }: { item: FeedAgent }): JSX.Element | null {
  if (item.status !== 'running') {
    return item.durationMs === undefined ? null : <span className="shrink-0">{formatDuration(item.durationMs)}</span>;
  }
  return <RunningFor since={item.at} />;
}

function RunningFor({ since }: { since: string }): JSX.Element | null {
  const now = useNow(1000);
  const started = Date.parse(since);
  if (Number.isNaN(started)) return null;
  return <span className="shrink-0">{formatDuration(now.getTime() - started)}</span>;
}

export function AgentItem({ item, expanded, onToggle, transcript, onTranscript: setTranscript }: AgentItemProps): JSX.Element {
  const { bridge, sessionRef } = useChatEnv();
  const Icon = (item.agentType === null ? undefined : TYPE_ICONS[item.agentType]) ?? Bot;
  const title = item.description ?? item.agentType ?? S.chat.agent.fallbackTitle;
  const statusWord = S.chat.agent.status[item.status];
  const meta = [item.agentType, item.model, item.background ? S.chat.agent.background : null].filter(
    (part): part is string => part !== null,
  );

  const toggleTranscript = (): void => {
    if (transcript !== null) {
      setTranscript(() => null);
      return;
    }
    const agentId = item.agentId;
    if (agentId === null) return;
    setTranscript(() => ({ state: 'loading' }));
    bridge.call('feed.snapshot', { ref: sessionRef, agentId }).then(
      (snapshot) => setTranscript((was) => (was === null ? was : { state: 'ready', items: snapshot.items })),
      (error: unknown) => {
        console.warn('[parley] feed.snapshot agent', decodeIpcError(error).message);
        setTranscript((was) => (was === null ? was : { state: 'error' }));
      },
    );
  };

  return (
    <div
      data-testid="chat-agent"
      data-agent-status={item.status}
      className="flex min-w-0 flex-col gap-1.5 rounded-md border border-border px-3 py-2 text-sm"
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={S.chat.agent.details}
        title={title}
        onClick={onToggle}
        className="flex w-full min-w-0 items-start gap-2 text-left"
      >
        <ChevronRight className={cn('mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')} aria-hidden="true" />
        <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span data-agent-title="" className="truncate font-semibold">
            {title}
          </span>
          <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            {meta.length === 0 ? null : <span className="min-w-0 truncate">{meta.join(' · ')}</span>}
            <span className="inline-flex shrink-0 items-center gap-1">
              {item.status === 'running' ? (
                <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              ) : null}
              <span className={item.status === 'failed' ? 'text-destructive' : undefined}>{statusWord}</span>
            </span>
            <span className="shrink-0">{S.chat.agent.toolCalls(item.toolCount)}</span>
            <AgentDuration item={item} />
          </span>
        </span>
      </button>
      {expanded ? (
        <div data-testid="chat-agent-details" className="flex min-w-0 flex-col gap-1.5 pl-6">
          {item.children.length === 0 ? null : (
            <div data-testid="chat-agent-children" className="flex min-w-0 flex-col">
              {item.children.map((child) => (
                <ToolItem key={child.id} item={child} compact />
              ))}
            </div>
          )}
          {item.result === undefined ? null : (
            <div className="min-w-0 text-sm [overflow-wrap:anywhere]">
              <span className="text-xs text-muted-foreground">{S.chat.agent.result}</span>
              <RoomMarkdown text={item.result} labelOf={noLabel} onOpenExternal={(url) => void bridge.app.openExternal(url)} />
            </div>
          )}
          {item.agentId === null ? null : (
            <button
              type="button"
              aria-expanded={transcript !== null}
              onClick={toggleTranscript}
              className="self-start rounded-full border border-border px-2.5 py-0.5 text-xs hover:bg-foreground/7"
            >
              {transcript === null ? S.chat.showTranscript : S.chat.hideTranscript}
            </button>
          )}
          {transcript === null ? null : <TranscriptArea transcript={transcript} />}
        </div>
      ) : null}
    </div>
  );
}

function TranscriptArea({ transcript }: { transcript: Transcript }): JSX.Element {
  const { bridge } = useChatEnv();
  if (transcript.state === 'loading') return <p className="m-0 text-xs text-muted-foreground">{S.chat.agent.transcriptLoading}</p>;
  if (transcript.state === 'error') return <p className="m-0 text-xs text-[var(--status-warning-text)]">{S.chat.agent.transcriptFailed}</p>;
  const total = transcript.items.length;
  if (total === 0) return <p className="m-0 text-xs text-muted-foreground">{S.chat.agent.transcriptEmpty}</p>;
  const shown = total > TRANSCRIPT_TAIL ? transcript.items.slice(-TRANSCRIPT_TAIL) : transcript.items;
  return (
    <div data-testid="chat-agent-transcript" className="flex max-h-96 min-w-0 flex-col gap-1.5 overflow-y-auto border-l border-border pl-2">
      {shown.length === total ? null : (
        <p data-testid="chat-agent-transcript-tail" className="m-0 text-xs text-muted-foreground">
          {S.chat.agent.transcriptTail(shown.length, total)}
        </p>
      )}
      {shown.map((entry) => {
        if (entry.kind === 'tool') return <ToolItem key={entry.id} item={entry} compact />;
        if (entry.kind === 'text' || entry.kind === 'prompt') {
          return (
            <div key={entry.id} className="min-w-0 text-xs [overflow-wrap:anywhere]">
              <RoomMarkdown text={entry.text} labelOf={noLabel} onOpenExternal={(url) => void bridge.app.openExternal(url)} />
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}
