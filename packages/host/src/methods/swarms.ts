/**
 * Методы `swarms.*` (спека роя v1, 6): отмена и «человек увидел итог» — чистые записи в карту. Закрытие живых участников
 * отменённого роя и доставку итога делает `SwarmsService` на следующем снимке карты.
 */

import { isSwarmTerminal, updateMap } from '@parley/core';
import type { WorkMap, WorkSwarm } from '@parley/core';
import type { Handler } from '../context.js';
import { HostError } from '../errors.js';
import type { SessionsService } from '../sessions/sessions-service.js';
import { swarmMemberOf } from '../swarms/spawn.js';
import { notFoundOnGone, requireWork } from './works.js';

function swarmOf(map: WorkMap, swarmId: string): WorkSwarm {
  const swarm = map.swarms?.find((candidate) => candidate.id === swarmId);
  if (swarm === undefined) throw new HostError('not_found', `swarm ${swarmId} does not exist`);
  return swarm;
}

// Рой из окна: королеву заводит `sessions.create` с внутренним полем `swarm`. Создатель — человек, рой и королева в лимиты
// агентов не считаются, модель и усилие проверяет тот же `resolveModelChoice`. Королева всегда облегчённая (`lean: true`):
// она только координирует, MCP человека ей не нужны, а диалог «new MCP servers found» держал её до ответа человека (b-013).
export const createSwarmsCreate = (sessions: Pick<SessionsService, 'create'>): Handler<'swarms.create'> =>
  async ({ projectPath, workId, tag, objective, provider, role, model, effort }) => {
    requireWork(projectPath, workId);
    const created = await sessions.create({
      projectPath, workId, provider, label: '', task: objective, parent: null,
      swarm: { kind: 'create', tag, objective }, lean: true,
      ...(role === undefined ? {} : { role }),
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
    });
    const member = await swarmMemberOf(created);
    if (member === undefined) throw new HostError('internal', `session ${created.sessionId} was created but is not in a swarm`);
    return { swarmId: member.swarmId, queenSessionId: created.sessionId };
  };

// Отмена человеком из меню строки роя. Рой, который уже закончил, не трогаем: повтор и гонка с королевой — не ошибка.
export const swarmsCancel: Handler<'swarms.cancel'> = async ({ projectPath, workId, swarmId }) => {
  requireWork(projectPath, workId);
  await updateMap(projectPath, workId, (map) => {
    const swarm = swarmOf(map, swarmId);
    if (isSwarmTerminal(swarm.status)) return;
    swarm.status = 'cancelled';
    swarm.failure = 'cancelled by the human';
    swarm.endedAt = new Date().toISOString();
  }).catch(notFoundOnGone);
  return { ok: true };
};

// Карточка раскрыта: `seenAt` ставится один раз. Не событие работы: `updatedAt` стоит на месте.
export const swarmsSeen: Handler<'swarms.seen'> = async ({ projectPath, workId, swarmId }) => {
  requireWork(projectPath, workId);
  await updateMap(
    projectPath,
    workId,
    (map) => {
      const swarm = swarmOf(map, swarmId);
      swarm.seenAt ??= new Date().toISOString();
    },
    { touch: false },
  ).catch(notFoundOnGone);
  return { ok: true };
};
