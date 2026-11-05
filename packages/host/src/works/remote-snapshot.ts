/**
 * Снимок работ для моста телефона (клиент с ролью `remote`): та же форма `WorksSnapshot`, что у снимка без писем
 * (`mailWorkMap`), но без полей, которых мост не читает. Мост читает снимок в трёх местах: проекция для телефона
 * (`projectWorksSnapshot`, protocol/remote/projection.ts), счётчик «нужен ты» (`needsYouWorkOfMap`, core attention.ts) и
 * имена сессий и комнат для журнала (`sessionLabelOf`, `roomLabelOf` в remote/dispatch.ts). Задача, сводка, история кроме
 * последней записи, артефакты, `contextFrom`, планы, их эффекты, тело плана в решении комнаты, цель работы и пути
 * обрезанных полей (`compact.cut`, `compact.omitted`) ни в одном из них не участвуют — их и не шлём.
 */

import { planRefOf } from '@parley/core';
import type { WindowWorkMap } from '@parley/core';

export function remoteWorkMap(map: WindowWorkMap): WindowWorkMap {
  const next: WindowWorkMap = {
    ...map,
    work: { ...map.work, goal: '' },
    sessions: map.sessions.map((session) => ({
      ...session,
      task: '',
      summary: session.summary === null ? null : '',
      // Проекция берёт только последнюю запись (`lastEvent`).
      history: session.history.slice(-1),
      artifacts: [],
      contextFrom: [],
    })),
    rooms: map.rooms.map((room) => {
      if (room.proposal?.plan === undefined) return room;
      // Вместо плана — его личность по правилу `planRefOf`: проекция читает `plan?.id ?? planId`, значение то же.
      const proposal = { ...room.proposal, ...planRefOf(room.proposal) };
      delete proposal.plan;
      return { ...room, proposal };
    }),
  };
  delete next.plans;
  delete next.planEffects;
  if (next.compact !== undefined) next.compact = { ...next.compact, cut: [], omitted: {} };
  return next;
}
