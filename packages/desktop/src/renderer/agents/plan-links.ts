import type { WorkEntry } from '@parley/core';

export function roomPlanLinks(
  entry: WorkEntry,
  sessionId: string,
): { roomId: string; planId: string; itemId: number; title: string; scope: string }[] {
  return (entry.map.plans ?? [])
    .filter((plan) => plan.status === 'active' || plan.status === 'completing')
    .flatMap((plan) =>
      plan.items
        .filter(
          (item) =>
            item.owner === sessionId &&
            ['ready', 'in_progress', 'blocked', 'returned'].includes(item.status),
        )
        .map((item) => ({
          roomId: plan.roomId,
          planId: plan.id,
          itemId: item.id,
          title: item.title,
          scope: item.scope,
        })),
    );
}
