import type { FeedPlanCard } from '@parley/core';
import { Button } from '../ui/button.js';

export interface PlanViewLabels {
  plan: string;
  approveAuto: string;
  approveManual: string;
  changeInTerminal: string;
  truncated: string;
  terminalOnly: string;
  openInParley: string;
}

export interface PlanViewProps {
  card: FeedPlanCard;
  /** Parent owns arming, in-flight decisions and the elsewhere state. */
  disabled: boolean;
  canDecide: boolean;
  /** Space remaining after the notch, header and footer. */
  maxBodyHeight: number;
  labels: PlanViewLabels;
  onDecide(choice: 'auto-accept' | 'manual'): void;
  onOpenTerminal(): void;
  onOpenInParley(): void;
}

/** Plain-text plan only; the parent owns identity, focus, arming and transport. */
export function PlanView({ card, disabled, canDecide, maxBodyHeight, labels, onDecide, onOpenTerminal, onOpenInParley }: PlanViewProps): JSX.Element {
  return (
    <div className="flex min-h-0 flex-col gap-2" data-no-drag>
      <div
        role="region"
        aria-label={labels.plan}
        tabIndex={0}
        className="min-h-0 overflow-y-auto whitespace-pre-wrap font-mono text-sm [overflow-wrap:anywhere]"
        style={{ maxHeight: Number.isFinite(maxBodyHeight) ? Math.min(280, Math.max(0, maxBodyHeight)) : 280 }}
      >
        {card.plan}
      </div>
      {card.truncated ? <div className="shrink-0 text-muted-foreground">{labels.truncated}</div> : null}
      {!canDecide ? <div className="shrink-0 text-muted-foreground">{labels.terminalOnly}</div> : null}
      <div className="flex shrink-0 flex-wrap gap-2">
        {canDecide && card.state === 'pending' ? (
          <>
            <Button type="button" className="h-auto min-h-9 cursor-pointer whitespace-normal py-2 text-sm" disabled={disabled} onClick={() => onDecide('auto-accept')}>
              {labels.approveAuto}
            </Button>
            <Button type="button" variant="outline" className="h-auto min-h-9 cursor-pointer whitespace-normal py-2 text-sm" disabled={disabled} onClick={() => onDecide('manual')}>
              {labels.approveManual}
            </Button>
          </>
        ) : null}
        <Button type="button" variant="outline" className="h-auto min-h-9 cursor-pointer whitespace-normal py-2 text-sm" onClick={onOpenTerminal}>
          {labels.changeInTerminal}
        </Button>
        <Button type="button" variant="outline" className="h-auto min-h-9 cursor-pointer whitespace-normal py-2 text-sm" onClick={onOpenInParley}>
          {labels.openInParley}
        </Button>
      </div>
    </div>
  );
}
