/**
 * Значок расхода токенов в шапке комнаты (спека расхода токенов, 3.1–3.3): `↑1.2M ↓84k`, по клику — поповер с итогом,
 * провайдерами, участниками и Copy. Хост спрашивается только при `active` (6.3): при открытии, при смене состава или
 * архива и при изменении живых цифр участников, но не чаще раза в 10 секунд. Старый хост метода не знает — значка нет.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { RoomUsage, UsageCounters, WorkEntry } from '@parley/core';
import type { ParleyBridge } from '../../../shared/bridge.js';
import { S } from '../../../shared/strings.js';
import { useHostSupports } from '../../lib/capabilities.js';
import {
  createUsageLabels,
  memberMarks,
  usageCells,
  usageChipText,
  usageMarkdown,
  type UsageLabels,
} from '../../lib/usage-format.js';
import { activityFor, useActivityStore } from '../../store/activity.js';
import { useHostStore } from '../../store/host.js';
import { Button } from '../../ui/button.js';
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover.js';

const U = S.usage;

/** Не чаще раза в 10 секунд (6.3). */
export const ROOM_USAGE_MIN_INTERVAL_MS = 10_000;

/** Колонки одной ширины в итоге и в списке участников: две сетки не разъезжаются. */
const GRID = 'grid grid-cols-[minmax(0,1fr)_repeat(4,4.5rem)] items-baseline gap-x-3 gap-y-1';

export interface RoomUsageChipProps {
  bridge: ParleyBridge;
  entry: WorkEntry;
  roomId: string;
  /** Вкладка комнаты активна (`RoomBody.active`): неактивная хост не спрашивает. */
  active: boolean;
  providers: ReadonlyArray<{ id: string; label: string }>;
}

export function RoomUsageChip({ bridge, entry, roomId, active, providers }: RoomUsageChipProps): JSX.Element | null {
  const supported = useHostSupports('rooms.usage');
  const connected = useHostStore((state) => state.status.state === 'connected');
  const projectPath = entry.projectPath;
  const workId = entry.map.work.id;
  const room = entry.map.rooms.find((candidate) => candidate.id === roomId);
  // Состав, журнал и архив: смена любого — повод спросить заново.
  const composition =
    room === undefined ? '' : JSON.stringify([room.creator, room.members, room.archivedAt ?? null, room.memberLog?.length ?? 0]);
  const sessionIds = useMemo(
    () => (room === undefined ? [] : [...new Set([room.creator, ...room.members, ...(room.memberLog ?? []).map((record) => record.session)])]),
    // `composition` — снимок ровно тех полей, из которых собран список.
    [composition],
  );
  // Строка из живых цифр участников: изменилась — расход мог вырасти.
  const signal = useActivityStore((state) =>
    sessionIds
      .map((sessionId) => {
        const metrics = activityFor(state.byRef, { projectPath, workId, sessionId })?.metrics;
        return `${metrics?.tokensIn ?? ''}/${metrics?.tokensOut ?? ''}`;
      })
      .join('|'),
  );
  const [usage, setUsage] = useState<RoomUsage | null>(null);
  const [failed, setFailed] = useState(false);
  const lastRequest = useRef(0);
  const identity = `${projectPath}\u0000${workId}\u0000${roomId}`;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;

  // Другая комната — прежние цифры не её.
  useEffect(() => {
    setUsage(null);
    setFailed(false);
    lastRequest.current = 0;
  }, [identity]);

  useEffect(() => {
    if (!active || !supported || !connected) return;
    const wait = Math.max(0, lastRequest.current + ROOM_USAGE_MIN_INTERVAL_MS - Date.now());
    const timer = setTimeout(() => {
      lastRequest.current = Date.now();
      const asked = identity;
      bridge.call('rooms.usage', { projectPath, workId, roomId }).then(
        (value) => {
          if (currentIdentity.current !== asked) return;
          setUsage(value);
          setFailed(false);
        },
        () => {
          if (currentIdentity.current === asked) setFailed(true);
        },
      );
    }, wait);
    return () => clearTimeout(timer);
  }, [active, supported, connected, identity, composition, signal, bridge, projectPath, workId, roomId]);

  if (!supported || room === undefined) return null;
  const labels = createUsageLabels(entry.map.sessions, providers);
  const broken = failed && usage === null;
  const copy = (): void => {
    if (usage === null) return;
    navigator.clipboard.writeText(usageMarkdown(usage, room.title, labels)).then(
      () => toast(U.copied),
      (error: unknown) => console.warn('[parley] clipboard', error),
    );
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="xs"
          variant="outline"
          data-testid="room-usage-chip"
          title={broken ? U.unavailable : U.title}
          className="shrink-0 font-mono tabular-nums"
        >
          {broken ? '—' : usage === null ? '…' : usageChipText(usage.total)}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        data-testid="room-usage-popover"
        className="max-h-[calc(var(--radix-popover-content-available-height)-8px)] w-[min(560px,calc(100vw-32px))] overflow-y-auto p-3 text-xs"
      >
        {usage === null ? (
          <p className="text-muted-foreground">{failed ? U.unavailable : U.counting}</p>
        ) : (
          <UsageTable usage={usage} labels={labels} onCopy={copy} />
        )}
      </PopoverContent>
    </Popover>
  );
}

function UsageTable({ usage, labels, onCopy }: { usage: RoomUsage; labels: UsageLabels; onCopy: () => void }): JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium">
          {U.title} · {U.since}
        </span>
        <Button type="button" size="xs" variant="outline" data-testid="room-usage-copy" onClick={onCopy} className="shrink-0">
          {U.copy}
        </Button>
      </div>
      <div className={GRID}>
        <span />
        {U.columns.map((column) => (
          <span key={column} className="truncate text-right text-muted-foreground">
            {column}
          </span>
        ))}
        <UsageRow label={U.total} tags={[]} marks={usage.total.completeness === 'partial' ? [U.partial] : []} counters={usage.total} strong />
        {usage.byProvider.length > 1
          ? usage.byProvider.map((item) => (
              <UsageRow
                key={item.provider}
                label={labels.provider(item.provider)}
                tags={[]}
                marks={item.total.completeness === 'partial' ? [U.partial] : []}
                counters={item.total}
                indent
              />
            ))
          : null}
      </div>
      <div data-testid="room-usage-members" className={`${GRID} max-h-[min(40vh,240px)] overflow-y-auto border-t border-border pt-2`}>
        {usage.members.map((member) => (
          <UsageRow
            key={member.sessionId}
            label={labels.memberName(member)}
            tags={labels.memberTags(member)}
            marks={memberMarks(member)}
            counters={member.usage}
          />
        ))}
      </div>
      <p className="text-muted-foreground">{U.footnote}</p>
      {usage.reconstructed ? <p className="text-muted-foreground">{U.reconstructed}</p> : null}
      <p className="text-muted-foreground">{U.updated(usage.computedAt)}</p>
    </div>
  );
}

function UsageRow({
  label,
  tags,
  marks,
  counters,
  strong = false,
  indent = false,
}: {
  label: string;
  tags: readonly string[];
  marks: readonly string[];
  counters: UsageCounters | null;
  strong?: boolean;
  indent?: boolean;
}): JSX.Element {
  // У строки без цифр (не запущена, нет лога) — прочерки: `?` значил бы «число есть, но неизвестно».
  const cells = counters === null ? ['—', '—', '—', '—'] : usageCells(counters);
  const detail = [...tags, ...marks];
  return (
    <>
      <span title={[label, ...detail].join(' · ')} className={`flex min-w-0 flex-col${indent ? ' pl-3' : ''}`}>
        <span data-usage-label="" className={`min-w-0 truncate${strong ? ' font-medium' : ''}`}>
          {label}
        </span>
        {detail.length > 0 ? (
          <span data-usage-detail="" className="whitespace-normal break-words text-muted-foreground">
            {detail.join(' · ')}
          </span>
        ) : null}
      </span>
      {cells.map((value, index) => (
        <span key={index} data-usage-value="" className="text-right font-mono tabular-nums">
          {value}
        </span>
      ))}
    </>
  );
}
