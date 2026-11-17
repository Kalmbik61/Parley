/**
 * Панель пункта плана на доске комнаты (спека доски комнаты 4.4): только чтение. Исполнитель, тело строки пункта из
 * списка плана с раскрытыми подробностями, переход к сессии и к списку плана в ленте. Действий над планом здесь нет.
 */

import type { PlanItem, RoomPlan, WindowWorkEntry } from '@parley/core';
import type { ParleyBridge } from '../../../../shared/bridge.js';
import { S } from '../../../../shared/strings.js';
import { Button } from '../../../ui/button.js';
import { Dialog, DialogContent, DialogTitle } from '../../../ui/dialog.js';
import { AgentIcon } from '../../AgentIcon.js';
import { PlanItemBody } from '../PlanPanel.js';
import type { BoardAgent } from './room-board-model.js';

export interface RoomBoardItemSheetProps {
  plan: RoomPlan;
  /** Открытый пункт; `null` — панель закрыта. */
  item: PlanItem | null;
  agent: BoardAgent | null;
  entry: WindowWorkEntry;
  bridge: ParleyBridge;
  onClose: () => void;
  /** Вернуть фокус на карточку после обычного закрытия. */
  onReturnFocus: () => void;
  onOpenSession: (sessionId: string) => void;
  onShowInFeed: () => void;
}

export function RoomBoardItemSheet({
  plan,
  item,
  agent,
  entry,
  bridge,
  onClose,
  onReturnFocus,
  onOpenSession,
  onShowInFeed,
}: RoomBoardItemSheetProps): JSX.Element {
  const known = agent !== null && agent.provider !== null;
  return (
    <Dialog open={item !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        aria-describedby={undefined}
        data-room-item-sheet=""
        className="left-auto right-0 top-0 h-full max-h-none w-full max-w-[420px] translate-x-0 translate-y-0 rounded-none data-[state=closed]:slide-out-to-right-full data-[state=open]:slide-in-from-right-full data-[state=closed]:zoom-out-100 data-[state=open]:zoom-in-100"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onReturnFocus();
        }}
      >
        <DialogTitle>{item === null ? '' : S.roomBoard.sheet(item.id)}</DialogTitle>
        {item === null ? null : (
          <div className="flex min-w-0 flex-col gap-3 text-sm">
            <div className="flex min-w-0 items-center gap-2" data-sheet-agent="">
              {agent === null ? (
                <span className="font-medium">{S.roomBoard.engine}</span>
              ) : (
                <>
                  {agent.provider === null ? null : <AgentIcon provider={agent.provider} size={16} sessionId={agent.id} />}
                  <span className="min-w-0 truncate font-medium">{agent.label}</span>
                  {agent.word === '' ? null : <span className="shrink-0 text-muted-foreground">{agent.word}</span>}
                </>
              )}
            </div>
            <PlanItemBody plan={plan} item={item} entry={entry} bridge={bridge} expanded />
            <div className="flex flex-wrap gap-2">
              {known ? (
                <Button type="button" size="sm" variant="outline" onClick={() => onOpenSession(agent.id)}>
                  {S.roomBoard.openSession}
                </Button>
              ) : null}
              <Button type="button" size="sm" variant="outline" onClick={onShowInFeed}>
                {S.roomBoard.showInFeed}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
