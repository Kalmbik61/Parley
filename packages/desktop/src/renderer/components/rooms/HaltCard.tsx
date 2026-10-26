import type { RoomPlan, WorkEntry } from '@parley/core';
import type { ParleyBridge } from '../../../shared/bridge.js';
import { S } from '../../../shared/strings.js';
import { isRoomArchived } from '../../lib/room-archive.js';
import { Button } from '../../ui/button.js';
import { usePlanRequest } from './PlanPanel.js';

export function HaltCard({ plan, entry, bridge }: { plan: RoomPlan; entry: WorkEntry; bridge: ParleyBridge }): JSX.Element | null {
  const halted = plan.mode === 'autonomous' ? plan.autonomous?.halted : null;
  const room = entry.map.rooms.find(row => row.id === plan.roomId);
  const action = usePlanRequest(
    [entry.projectPath, entry.map.work.id, plan.roomId, plan.id, plan.rev, halted?.at].join('\0'),
    bridge, entry.map.work.status, room !== undefined && isRoomArchived(room),
  );
  if (!halted) return null;
  return (
    <section data-halt-card="" className="max-w-[680px] space-y-2 rounded border p-4 text-sm">
      <h4>{S.plans.halted}</h4>
      {halted.reason === 'human' ? null : <span>{S.plans.haltReason[halted.reason]}</span>}
      <p className="whitespace-pre-wrap break-words">{halted.detail}</p>
      {action.methods.has('plans.resumeAutonomous') ? (
        <Button type="button" disabled={action.busy || action.succeeded || !action.canMutate || !['active', 'completing'].includes(plan.status)} onClick={() => {
          void action.run(() => bridge.call('plans.resumeAutonomous', {
            projectPath: entry.projectPath, workId: entry.map.work.id, roomId: plan.roomId, planId: plan.id, rev: plan.rev,
          }));
        }}>{S.plans.continue}</Button>
      ) : <p>{S.plans.oldHost}</p>}
      {action.feedback ? <p role="status">{action.feedback}</p> : null}
    </section>
  );
}
