/**
 * Какие pending-сессии поднимает фоновый autoLaunch — план, кусок 1.7.
 *
 * Автозапуск получают только сессии, которых породил агент (`spawn_session` в
 * core всегда пишет им родителя) и которые появились в карте уже при этом
 * хосте: сессия, ручную создающая через `sessions.create`, сама вызывает
 * `launch()` из `SessionsService`, а всё, что было в карте на самое первое
 * чтение работы хостом, могло зависнуть в `pending` из-за прошлого падения
 * хоста — трогать её без спроса нельзя (план, раздел «на что смотреть», п. 2).
 */

import type { WorkEntry } from '@harnas/core';

export function autoLaunchCandidates(
  previous: WorkEntry | undefined,
  next: WorkEntry,
  firstReadDone: boolean,
): string[] {
  if (!firstReadDone) return [];

  const knownIds = new Set(previous?.map.sessions.map((session) => session.id) ?? []);
  return next.map.sessions
    .filter(
      (session) =>
        session.lifecycle === 'pending' && session.parent !== null && !knownIds.has(session.id),
    )
    .map((session) => session.id);
}
