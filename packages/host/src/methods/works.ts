import {
  createWork,
  deleteWorkFiles,
  isAlive,
  readMap,
  renameWork,
  setWorkStatus,
  WorkNotFoundError,
} from '@parley/core';
import type { Handler } from '../context.js';
import { HostError } from '../errors.js';
import type { WorksService } from '../works/works-service.js';

/**
 * `works.list` читает снимок сервиса: он один держит слитую по всем проектам картину.
 * Ожидание первого чтения работ — в общих воротах `WORKS_GATED_METHODS` (`methods/index.ts`).
 */
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
    (session) => session.lifecycle === 'active' && session.pid !== null && isAlive(session.pid),
  );
  if (busy === true) {
    throw new HostError('conflict', `workspace ${params.workId} has a live session`);
  }
  await deleteWorkFiles(params.projectPath, params.workId);
  return { ok: true };
};

/**
 * Работы нет — `not_found`, а не `internal`. Карта читается заранее, как в
 * `worksDelete` (битая карта — тоже `not_found`), а работу, удалённую уже после
 * этой проверки (`works.delete` другого клиента во время ожидания `map.lock`),
 * core сообщает `WorkNotFoundError` из самой записи.
 */
export async function requireWork(projectPath: string, workId: string): Promise<void> {
  const map = await readMap(projectPath, workId).catch(() => null);
  if (map === null) throw new HostError('not_found', `workspace ${workId} does not exist`);
}

export function notFoundOnGone(error: unknown): never {
  if (error instanceof WorkNotFoundError) throw new HostError('not_found', error.message);
  throw error;
}

export const worksRename: Handler<'works.rename'> = async (params) => {
  // Пустое или длинное название отсекает схема протокола (`bad_request`) —
  // те же правила, что у core, поэтому до `renameWork` оно не доходит.
  await requireWork(params.projectPath, params.workId);
  await renameWork(params.projectPath, params.workId, params.title).catch(notFoundOnGone);
  return { ok: true };
};

export const worksSetStatus: Handler<'works.setStatus'> = async (params) => {
  await requireWork(params.projectPath, params.workId);
  await setWorkStatus(params.projectPath, params.workId, params.status).catch(notFoundOnGone);
  return { ok: true };
};
