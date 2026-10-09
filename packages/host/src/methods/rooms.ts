/**
 * Методы `rooms.*`: комната и письмо человека из окна (план, кусок 3.5).
 * Правила живут в `rooms/rooms-service.ts` — здесь только форма ответа.
 */

import type { Handler } from '../context.js';
import {
  addRoomMember,
  archiveHumanRoom,
  createHumanRoom,
  deleteHumanRoom,
  renameHumanRoom,
  reopenHumanRoom,
  resolveRoomProposal,
  sendHumanLetter,
  setHumanRoomLead,
} from '../rooms/rooms-service.js';
import type { SessionsService } from '../sessions/sessions-service.js';

import { HUMAN, SYSTEM, DEFAULT_CONFIG, loadConfig, updateMap, workPaths, setRoomMode,
  cancelRoomPlan, updatePlanItem, submitPlanItem, verifyPlanItem, capturePlanNotice,
  reservePlanEffects, reconcileRoomPlans, readMap, summarizePlanEffects, PlanConflictError, RoomRuleError } from '@parley/core';
import { existsSync } from 'node:fs';
import type { PlanMethodName, PlanMethodParams, PlanActionResult } from '@parley/protocol';
import { HostError } from '../errors.js';
import type { PlanEffectsService } from '../rooms/plan-effects.js';

export const roomsCreate: Handler<'rooms.create'> = async (params) => ({
  roomId: await createHumanRoom(params),
});

export const roomsSend: Handler<'rooms.send'> = async (params) => ({
  messageId: await sendHumanLetter(params),
});

export const roomsAddMember: Handler<'rooms.addMember'> = async (params) => ({
  messageId: await addRoomMember(params),
});

export const roomsRename: Handler<'rooms.rename'> = async (params) => {
  await renameHumanRoom(params);
  return { ok: true };
};

export const roomsSetLead: Handler<'rooms.setLead'> = async (params) => ({
  messageId: await setHumanRoomLead(params),
});

export const roomsDelete: Handler<'rooms.delete'> = async (params) => {
  await deleteHumanRoom(params);
  return { ok: true };
};

/**
 * `rooms.archive` остаётся обёрткой над сервисом комнат, но ему нужны живые процессы сессий (остановка, письма только
 * живым), поэтому обработчик строится фабрикой, как у `sessions.*`.
 */
export function createRoomsArchive(sessions: Pick<SessionsService, 'live' | 'stop'>): Handler<'rooms.archive'> {
  return async (params) => {
    await archiveHumanRoom(params, sessions);
    return { ok: true };
  };
}

export const roomsReopen: Handler<'rooms.reopen'> = async (params) => {
  await reopenHumanRoom(params);
  return { ok: true };
};

export const roomsResolveProposal: Handler<'rooms.resolveProposal'> = async (params) => ({
  messageId: await resolveRoomProposal(params),
});

class NoChange extends Error {}
export function createPlanHandlers(effects: PlanEffectsService): { [M in PlanMethodName]: Handler<M> } {
  async function mutate<M extends PlanMethodName>(name: M, params: PlanMethodParams<M>): Promise<PlanActionResult> {
    const { projectPath, workId } = params;
    if (!existsSync(workPaths(projectPath, workId).map)) throw new HostError('not_found', 'Workspace is unavailable.');
    let messageId: string | null = null;
    if (name !== 'plans.retryEffects') {
      const rate = (await loadConfig()).config.messageRate ?? DEFAULT_CONFIG.messageRate;
      try {
        await updateMap(projectPath, workId, map => {
          if (map.work.status !== 'active') throw new RoomRuleError('workspace is closed');
          reconcileRoomPlans(map);
          switch (name) {
            case 'rooms.setMode': {
              const input = params as PlanMethodParams<'rooms.setMode'>;
              const before = map.messages.length;
              setRoomMode(map, input.roomId, HUMAN, input.mode, input.reason, input.confirmCancel === undefined ? {} : { confirmCancel: input.confirmCancel });
              const source = map.messages.slice(before).find(row => row.from === SYSTEM && row.roomId === input.roomId && row.kind === 'note');
              if (!source) throw new NoChange();
              messageId = source.id;
              capturePlanNotice(map, input.roomId, 'mode', source.id);
              break;
            }
            case 'plans.update': {
              const input = params as PlanMethodParams<'plans.update'>;
              updatePlanItem(map,input.planId,input.rev,input.item,HUMAN,input.status,input.note); break;
            }
            case 'plans.submit': {
              const input = params as PlanMethodParams<'plans.submit'>;
              submitPlanItem(map,input.planId,input.rev,input.item,HUMAN,input.evidence); break;
            }
            case 'plans.verify': {
              const input = params as PlanMethodParams<'plans.verify'>;
              verifyPlanItem(map,input.planId,input.rev,input.item,HUMAN,input.verdict,input.note); break;
            }
            case 'plans.cancel': {
              const input = params as PlanMethodParams<'plans.cancel'>;
              cancelRoomPlan(map,input.planId,input.rev,HUMAN); break;
            }
          }
          reservePlanEffects(map, rate);
        });
      } catch (error) {
        if (!(error instanceof NoChange)) {
          if (error instanceof PlanConflictError) throw new HostError('conflict', 'Plan revision or item changed.');
          if (error instanceof RoomRuleError) throw new HostError('bad_request', 'Plan action is not allowed.');
          throw new HostError('internal', 'Plan action could not be saved.');
        }
      }
    }
    // Mutation already committed. A delivery/IO failure is partial, never a second mutation on retry.
    try { return { messageId, effects: await effects.flush(projectPath,workId) }; }
    catch {
      try { return { messageId, effects: summarizePlanEffects(await readMap(projectPath, workId)) }; }
      catch { throw new HostError('internal', 'Plan action was saved; delivery remains pending. Retry plan effects.'); }
    }
  }
  return {
    'rooms.setMode': params => mutate('rooms.setMode',params),
    'plans.update': params => mutate('plans.update',params),
    'plans.submit': params => mutate('plans.submit',params),
    'plans.verify': params => mutate('plans.verify',params),
    'plans.cancel': params => mutate('plans.cancel',params),
    'plans.retryEffects': params => mutate('plans.retryEffects',params),
  };
}
