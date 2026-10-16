/**
 * `rooms.usage` (спека расхода токенов, 6.1–6.2): итог комнаты по карте работы и логам провайдеров. Расчёт — `roomUsage`
 * ядра, цифры — `ActivityService.usageResolver` (готовый итог сессии или срез лога). Одновременные запросы одной комнаты
 * склеиваются в один расчёт.
 */

import { roomUsage, type RoomUsage, type UsageResolver, type WorkEntry } from '@parley/core';
import type { Handler } from '../context.js';
import { HostError } from '../errors.js';

export function createRoomsUsage(
  works: { entry(projectPath: string, workId: string): Pick<WorkEntry, 'map'> | undefined },
  activity: { usageResolver(): UsageResolver },
  now: () => string = () => new Date().toISOString(),
): Handler<'rooms.usage'> {
  const running = new Map<string, Promise<RoomUsage>>();
  return async ({ projectPath, workId, roomId }) => {
    const map = works.entry(projectPath, workId)?.map;
    if (map === undefined) throw new HostError('not_found', `work ${workId} is not open`);
    if (!map.rooms.some((room) => room.id === roomId)) throw new HostError('not_found', `room ${roomId} is not in the work`);
    const key = `${projectPath}\u0000${workId}\u0000${roomId}`;
    const known = running.get(key);
    if (known !== undefined) return known;
    const job = roomUsage(map, roomId, activity.usageResolver(), now()).finally(() => running.delete(key));
    running.set(key, job);
    return job;
  };
}
