/**
 * Лента вида «Chat» (план 2026-10-01, Task 3, п. 2): виртуальный список элементов разной высоты
 * (`@tanstack/react-virtual`, высота мерится `measureElement` и следит за раскрытием и ростом текста),
 * в DOM — только видимые и запас: лента в 2 000 элементов прокручивается без рывков (Review Focus 3).
 *
 * Прокрутка — как в ленте комнаты 0.2.0 (`components/rooms/RoomPanel.tsx`): стоит ли лента «у низа»
 * (не дальше `AT_BOTTOM_PX` от дна), запоминается по событию `scroll`, а не мерится при отрисовке. У
 * низа — новое и выросшее прижимается к низу; человек читает выше — его не дёргают, а снизу появляется
 * «Jump to latest».
 *
 * Программная прокрутка к низу сама порождает `scroll`, а виртуализатор между ней и событием успевает
 * поправить высоты по замеру — такое событие «не у низа» сорвало бы прилипание без действий человека,
 * поэтому ближайший `scroll` после неё не учитывается.
 *
 * Раскрытые вызовы и карточки агентов, а также транскрипты субагентов лента помнит по `id`: строку вне
 * экрана виртуальный список размонтирует, и своё состояние элемента пропало бы. В конце — серые
 * сообщения из очереди (`queued`, решение 8). Несколько агентов подряд — стопкой: между ними отступ меньше.
 *
 * Строка элемента — `memo`: дельта ленты сохраняет ссылки нетронутых элементов (`applyDelta`), а
 * обработчики раскрытия стабильны, поэтому дельта, меняющая один текст, перерисовывает одну строку.
 */

import { memo, useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, Loader2 } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { FeedItem } from '@parley/core';
import { S } from '../../shared/strings.js';
import { Button } from '../ui/button.js';
import { cn } from '../lib/cn.js';
import { formatDuration } from '../lib/metrics-line.js';
import { useNow } from '../lib/use-now.js';
import { AgentItem, type Transcript, type TranscriptUpdate } from './items/AgentItem.js';
import { CardItem } from './items/CardItem.js';
import { ErrorItem } from './items/ErrorItem.js';
import { NoticeItem } from './items/NoticeItem.js';
import { PromptItem } from './items/PromptItem.js';
import { TextItem } from './items/TextItem.js';
import { ToolItem } from './items/ToolItem.js';
import { TurnItem } from './items/TurnItem.js';

/** Лента «у низа», если до дна не больше стольких px — как у комнаты. */
const AT_BOTTOM_PX = 48;
/** Высота элемента до замера. */
const ESTIMATE_PX = 56;
/** Размер прокрутчика до первого замера (jsdom и первый кадр). */
const INITIAL_RECT = { width: 800, height: 600 };

/** Сообщение, ушедшее в очередь CLI во время хода, — серым до настоящего промпта. */
export interface QueuedPrompt {
  id: string;
  text: string;
}

type Row = { key: string; item: FeedItem } | { key: string; queued: QueuedPrompt };

export interface FeedListProps {
  items: readonly FeedItem[];
  queued: readonly QueuedPrompt[];
  /** Подпись пустой ленты: загрузка, пусто, ошибка; `null` — не нужна. */
  note: string | null;
  /** Есть — рядом с подписью кнопка «Retry» (лента не загрузилась). */
  onRetry?: () => void;
  /** Есть — под лентой строка «Working…» (агент работает, а текста ещё нет); `since` — начало хода, ISO, или `null`. */
  working?: { since: string | null };
}

/** Строка «Working…» с прошедшим временем (живая проверка 2026-10-02: терминал показывает спиннер, чат был пуст). */
function WorkingRow({ since }: { since: string | null }): JSX.Element {
  const now = useNow(1000);
  const started = since === null ? Number.NaN : Date.parse(since);
  const elapsed = Number.isNaN(started) ? null : Math.max(0, now.getTime() - started);
  return (
    <div data-testid="chat-working" className="px-4 pb-3 pt-1">
      <div className="mx-auto flex w-full max-w-[860px] items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
        <span>{elapsed === null ? S.chat.working : `${S.chat.working} ${formatDuration(elapsed)}`}</span>
      </div>
    </div>
  );
}

interface ItemViewProps {
  item: FeedItem;
  expanded: boolean;
  /** Транскрипт карточки агента; у прочих элементов — `null`. */
  transcript: Transcript | null;
  onToggle: (id: string) => void;
  onTranscript: (id: string, update: TranscriptUpdate) => void;
}

const ItemView = memo(function ItemView({ item, expanded, transcript, onToggle, onTranscript }: ItemViewProps): JSX.Element {
  switch (item.kind) {
    case 'prompt':
      return <PromptItem text={item.text} images={item.images} />;
    case 'text':
      return <TextItem item={item} />;
    case 'tool':
      return <ToolItem item={item} expanded={expanded} onToggle={() => onToggle(item.id)} />;
    case 'permission':
    case 'question':
    case 'plan':
      return <CardItem item={item} />;
    case 'agent':
      return (
        <AgentItem
          item={item}
          expanded={expanded}
          onToggle={() => onToggle(item.id)}
          transcript={transcript}
          onTranscript={(update) => onTranscript(item.id, update)}
        />
      );
    case 'notice':
      return <NoticeItem item={item} />;
    case 'error':
      return <ErrorItem item={item} />;
    case 'turn':
      return <TurnItem item={item} />;
  }
});

export function FeedList({ items, queued, note, onRetry, working }: FeedListProps): JSX.Element {
  const rows: Row[] = [
    ...items.map((item) => ({ key: item.id, item })),
    ...queued.map((entry) => ({ key: `queued:${entry.id}`, queued: entry })),
  ];
  // Прокрутчик — элементом в состоянии: виртуализатор должен увидеть его уже при монтировании.
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback((id: string): void => {
    setExpanded((was) => {
      const next = new Set(was);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);
  const [transcripts, setTranscripts] = useState<Readonly<Record<string, Transcript>>>({});
  const updateTranscript = useCallback((id: string, update: TranscriptUpdate): void => {
    setTranscripts((was) => {
      const next = update(was[id] ?? null);
      if (next === (was[id] ?? null)) return was;
      const copy = { ...was };
      if (next === null) delete copy[id];
      else copy[id] = next;
      return copy;
    });
  }, []);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller,
    estimateSize: () => ESTIMATE_PX,
    getItemKey: (index) => rows[index]?.key ?? index,
    initialRect: INITIAL_RECT,
    overscan: 6,
    paddingEnd: 12,
  });

  // «У низа» — по последнему `scroll`: после роста ленты по DOM уже не понять, где стоял человек.
  const atBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  /** Ближайший `scroll` вызван нашей же прокруткой к низу — его не учитываем. */
  const ownScrollRef = useRef(false);
  const onScroll = useCallback((): void => {
    if (scroller === null) return;
    if (ownScrollRef.current) {
      ownScrollRef.current = false;
      return;
    }
    const next = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= AT_BOTTOM_PX;
    atBottomRef.current = next;
    setAtBottom(next);
  }, [scroller]);

  const pinToBottom = useCallback((): void => {
    if (scroller === null) return;
    const before = scroller.scrollTop;
    scroller.scrollTop = scroller.scrollHeight;
    // Флаг — только на сдвиг: без него события не будет, и флаг съел бы следующую прокрутку человека.
    // Событие браузера приходит позже записи, поэтому флаг ставится после неё.
    if (scroller.scrollTop !== before) ownScrollRef.current = true;
    atBottomRef.current = true;
    setAtBottom(true);
  }, [scroller]);

  const total = virtualizer.getTotalSize();
  const last = items.at(-1);
  // Новый элемент, выросший текст, замер высоты — у низа лента остаётся у низа.
  useLayoutEffect(() => {
    if (atBottomRef.current) pinToBottom();
  }, [pinToBottom, total, rows.length, last, working !== undefined]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={setScroller} onScroll={onScroll} data-testid="chat-feed" className="min-h-0 flex-1 overflow-y-auto">
        {note === null || rows.length > 0 ? null : (
          <div className="flex items-center gap-2 px-4 py-3">
            <p className="m-0 text-sm text-muted-foreground">{note}</p>
            {onRetry === undefined ? null : (
              <Button type="button" size="xs" variant="outline" onClick={onRetry}>
                {S.common.retry}
              </Button>
            )}
          </div>
        )}
        <div className="relative w-full" style={{ height: total }}>
          {virtualizer.getVirtualItems().map((virtual) => {
            const row = rows[virtual.index];
            if (row === undefined) return null;
            const previous = rows[virtual.index - 1];
            const stacked =
              'item' in row && row.item.kind === 'agent' && previous !== undefined && 'item' in previous && previous.item.kind === 'agent';
            return (
              <div
                key={virtual.key}
                data-index={virtual.index}
                data-feed-id={'item' in row ? row.item.id : undefined}
                ref={virtualizer.measureElement}
                className={cn('absolute left-0 top-0 w-full px-4', stacked ? 'pt-1' : 'pt-3')}
                style={{ transform: `translateY(${virtual.start}px)` }}
              >
                <div className="mx-auto w-full max-w-[860px]">
                  {'item' in row ? (
                    <ItemView
                      item={row.item}
                      expanded={expanded.has(row.item.id)}
                      transcript={transcripts[row.item.id] ?? null}
                      onToggle={toggle}
                      onTranscript={updateTranscript}
                    />
                  ) : (
                    <PromptItem text={row.queued.text} queued />
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {working === undefined ? null : <WorkingRow since={working.since} />}
      </div>
      {atBottom ? null : (
        <Button
          type="button"
          size="xs"
          variant="secondary"
          onClick={pinToBottom}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-md"
        >
          <ArrowDown className="size-3.5" aria-hidden="true" />
          {S.chat.jumpToLatest}
        </Button>
      )}
    </div>
  );
}
