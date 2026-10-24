/**
 * Методы `rooms.*`: комната и письмо человека из окна (план, кусок 3.5).
 * Правила живут в `rooms/rooms-service.ts` — здесь только форма ответа.
 */

import { performance } from 'node:perf_hooks';
import type { Handler } from '../context.js';
import {
  addRoomMember,
  archiveHumanRoom,
  createHumanRoom,
  deleteHumanRoom,
  renameHumanRoom,
  reopenHumanRoom,
  resolveRoomProposal,
  resumeAutonomousPlan,
  sendHumanLetter,
  setHumanRoomLead,
  setHumanRoomOwner,
} from '../rooms/rooms-service.js';
import type { SessionsService } from '../sessions/sessions-service.js';

import { ENGINE, HUMAN, SYSTEM, DEFAULT_CONFIG, loadConfig, updateMap, workPaths, setRoomMode, requireOpenRoom, lateDefect,
  cancelRoomPlan, updatePlanItem, submitPlanItem, verifyPlanItem, capturePlanNotice,
  reservePlanEffects, reconcileRoomPlans, readMap, summarizePlanEffects, PlanConflictError, RoomRuleError } from '@parley/core';
import { existsSync } from 'node:fs';
import type { PlanMethodName, PlanMethodParams, PlanActionResult } from '@parley/protocol';
import { HostError } from '../errors.js';
import type { PlanEffectsService } from '../rooms/plan-effects.js';

// Журнал задержек (спека диагностики, A4): записи с `op`, только длины и идентификаторы — ни названия комнаты, ни текста письма.
export const roomsCreate: Handler<'rooms.create'> = async (params, { host }) => {
  const startedAt = performance.now();
  const roomId = await createHumanRoom(params);
  host.log.info('комната создана', {
    op: 'room.create',
    roomId,
    members: params.members.length,
    ms: Math.round(performance.now() - startedAt),
  });
  return { roomId };
};

export const roomsSend: Handler<'rooms.send'> = async (params, { host }) => {
  const startedAt = performance.now();
  // Метка окна — мс эпохи: без неё (старое окно) или из будущего (расхождение часов) ожидание не считается.
  const queueMs = params.requestedAt === undefined ? null : Math.max(0, Date.now() - params.requestedAt);
  const messageId = await sendHumanLetter(params);
  host.log.info('письмо принято', {
    op: 'rooms.send',
    messageId,
    to: params.to.length,
    roomId: params.roomId,
    queueMs,
    ms: Math.round(performance.now() - startedAt),
  });
  return { messageId };
};

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

export const roomsSetOwner: Handler<'rooms.setOwner'> = async (params) => {
  await setHumanRoomOwner(params);
  return { ok: true };
};

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

export const plansResumeAutonomous: Handler<'plans.resumeAutonomous'> = async params => {
  await resumeAutonomousPlan(params);
  return { ok: true };
};

class NoChange extends Error {}
export function createPlanHandlers(effects: PlanEffectsService, engine?: Pick<import('../rooms/autonomous-engine.js').AutonomousEngine, 'cancel'>): { [M in PlanMethodName]: Handler<M> } {
  async function mutate<M extends PlanMethodName>(name: M, params: PlanMethodParams<M>): Promise<PlanActionResult> {
    const { projectPath, workId } = params;
    if (!existsSync(workPaths(projectPath, workId).map)) throw new HostError('not_found', 'Workspace is unavailable.');
    let messageId: string | null = null;
    if (name !== 'plans.retryEffects') {
      const rate = (await loadConfig()).config.messageRate ?? DEFAULT_CONFIG.messageRate;
      try {
        if (name === 'plans.cancel') {
          const input = params as PlanMethodParams<'plans.cancel'>;
          const plan = (await readMap(projectPath, workId)).plans?.find(plan => plan.id === input.planId);
          if (plan?.mode === 'autonomous') {
            if (!engine) throw new HostError('internal', 'Autonomous engine is unavailable.');
            await engine.cancel(input);
          }
        }
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
              const index = map.plans?.findIndex(plan => plan.id === input.planId) ?? -1;
              const plan = map.plans?.[index];
              if (plan?.mode === 'autonomous' && input.verdict === 'returned') {
                if (plan.rev !== input.rev || !['active', 'completing', 'completed'].includes(plan.status)) throw new PlanConflictError();
                const room = requireOpenRoom(map, plan.roomId);
                const attempt = plan.autonomous?.attempts.findLast(row => row.item === input.item && row.status === 'integrated');
                if (!attempt || !input.note.trim()) throw new RoomRuleError('verified attempt and return reason required');
                const reopened = structuredClone(plan);
                if (reopened.status === 'completed') {
                  reopened.status = 'active'; reopened.completedAt = null; reopened.completionSummary = null;
                }
                const result = lateDefect(reopened, room, { actor: ENGINE, rev: input.rev, now: new Date().toISOString(), attemptId: attempt.id, reason: input.note });
                if (plan.status === 'completed') {
                  if (plan.rev === Number.MAX_SAFE_INTEGER) throw new PlanConflictError();
                  result.plan.rev++;
                  result.plan.items.find(item => item.id === input.item)!.log.push({ at: new Date().toISOString(), by: HUMAN, status: 'returned', note: `reopened by human (late defect): rev ${plan.rev} → ${result.plan.rev}; item ${input.item}; ${input.note}` });
                }
                map.plans![index] = result.plan;
                map.rooms[map.rooms.indexOf(room)] = result.room;
                break;
              }
              verifyPlanItem(map,input.planId,input.rev,input.item,HUMAN,input.verdict,input.note); break;
            }
            case 'plans.cancel': {
              const input = params as PlanMethodParams<'plans.cancel'>;
              const plan = map.plans?.find(plan => plan.id === input.planId);
              if (plan?.mode === 'autonomous' && plan.rev === input.rev && plan.status === 'cancelled') break;
              cancelRoomPlan(map,input.planId,input.rev,HUMAN); break;
            }
          }
          reservePlanEffects(map, rate);
        });
      } catch (error) {
        if (!(error instanceof NoChange)) {
          if (error instanceof PlanConflictError) throw new HostError('conflict', 'Plan revision or item changed.');
          if (error instanceof RoomRuleError) throw new HostError('bad_request', error.message.startsWith('autonomous-plan-needs-engine-cancel:') ? 'Cancel the autonomous plan first.' : 'Plan action is not allowed.');
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
