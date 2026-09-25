import { createWork, deleteWorkFiles, isAlive, readMap } from '@harnas/core';
import type { Handler } from '../context.js';
import { HostError } from '../errors.js';
import type { WorksService } from '../works/works-service.js';

/** `works.list` читает снимок сервиса: он один держит слитую по всем проектам картину. */
export function worksList(works: WorksService): Handler<'works.list'> {
  return async () => works.snapshot();
}

export const worksCreate: Handler<'works.create'> = async (params) => {
  const map = await createWork(params.projectPath, { title: params.title, goal: params.goal });
  return { workId: map.work.id };
};

export const worksDelete: Handler<'works.delete'> = async (params) => {
  // Карта читается заново, а не из снимка сервиса: снимок мог отстать от диска
  // на длительность debounce, а конфликт должен решаться по настоящему состоянию.
  const map = await readMap(params.projectPath, params.workId).catch(() => null);
  const busy = map?.sessions.some(
    (session) => session.status === 'active' && session.pid !== null && isAlive(session.pid),
  );
  if (busy === true) {
    throw new HostError('conflict', `у работы ${params.workId} есть живая сессия`);
  }
  await deleteWorkFiles(params.projectPath, params.workId);
  return { ok: true };
};
