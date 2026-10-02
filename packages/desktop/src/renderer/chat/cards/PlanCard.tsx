/**
 * Карточка одобрения плана (план 2026-10-01, решение 4, кусок 4a, решение Р): план Markdown-ом
 * (`RoomMarkdown`) и три кнопки. Первые две решают — «Approve, auto-accept edits» (`auto-accept`) и
 * «Approve, approve each edit» (`manual`); третья, «Change the plan in the terminal», решения не шлёт —
 * она переключает вкладку в терминал, где человек правит план сам. Хук, пока не держится, ответит
 * `applied: false` — тогда под кнопками «попробуй ещё раз».
 */

import type { FeedPlanCard } from '@parley/core';
import { S } from '../../../shared/strings.js';
import { RoomMarkdown } from '../../components/rooms/RoomMarkdown.js';
import { useLayoutStore } from '../../layout/store.js';
import { updateTab } from '../../layout/tree.js';
import { Button } from '../../ui/button.js';
import { useChatEnv } from '../chat-env.js';
import { CardFrame } from './CardFrame.js';
import { CardNote } from './CardNote.js';
import { useCardDecision } from './use-card-decision.js';

const noLabel = (): null => null;

function settledStatus(item: FeedPlanCard): string {
  if (item.state === 'pending') return S.chat.waiting;
  if (item.state === 'allowed' && item.choice !== undefined) return S.chat.card.planApproved[item.choice];
  return S.chat.cardState[item.state];
}

export function PlanCard({ item }: { item: FeedPlanCard }): JSX.Element {
  const { bridge, workKey, tabId } = useChatEnv();
  const { deciding, note, decide } = useCardDecision(item.cardId);
  if (item.state !== 'pending') return <CardFrame item={item} status={settledStatus(item)} />;

  const openTerminal = (): void => {
    if (workKey === undefined || tabId === undefined) return;
    useLayoutStore.getState().apply(workKey, (layout) => updateTab(layout, tabId, { view: 'terminal' }));
  };
  return (
    <CardFrame item={item} status={null}>
      <div data-testid="card-plan" className="max-h-64 min-w-0 overflow-auto rounded border border-border bg-background/60 px-2 py-1 text-sm [overflow-wrap:anywhere]">
        <RoomMarkdown text={item.plan} labelOf={noLabel} onOpenExternal={(url) => void bridge.app.openExternal(url)} />
      </div>
      {item.truncated === true ? <p className="m-0 text-xs text-[var(--status-warning-text)]">{S.chat.inputTruncated}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="xs" data-testid="card-approve-auto" disabled={deciding} onClick={() => decide({ kind: 'plan', choice: 'auto-accept' })}>
          {S.chat.card.approveAuto}
        </Button>
        <Button type="button" size="xs" variant="outline" data-testid="card-approve-manual" disabled={deciding} onClick={() => decide({ kind: 'plan', choice: 'manual' })}>
          {S.chat.card.approveManual}
        </Button>
        <Button type="button" size="xs" variant="outline" data-testid="card-open-terminal" onClick={openTerminal}>
          {S.chat.card.openTerminal}
        </Button>
      </div>
      <CardNote note={note} />
    </CardFrame>
  );
}
