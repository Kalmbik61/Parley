/**
 * Карточка согласия на папку на острове (спека 2026-10-21, 4.4): запуск Codex держится, пока человек не решит.
 * Заголовок, папка (середина длинного пути сокращена, полный путь — в подсказке), «requested by <кто> · <откуда>» и
 * кнопки Trust / Deny. Кнопки взводятся через `CARD_ARM_MS` после показа и после смены карточки, как у карточек
 * ленты. После решения вместо кнопок «Done ✓» (хост закрыл карточку) или «Already answered» (ответили в другом
 * месте); «Couldn't decide» — кнопки остаются. Чистый вид: решение уходит колбэком.
 */

import { useEffect, useState } from 'react';
import type { ConsentCard } from '@parley/protocol';
import { S } from '../../../shared/strings.js';
import { shortenMiddle } from '../../lib/shorten-middle.js';
import { switchRequestText } from '../../store/consents.js';
import { Button } from '../../ui/button.js';
import { CARD_ARM_MS } from '../arm.js';

export interface ConsentViewProps {
  card: ConsentCard;
  /** Решение по этой карточке в пути. */
  deciding: boolean;
  note: 'done' | 'elsewhere' | 'failed' | null;
  onDecide(id: string, decision: 'allow' | 'deny'): void;
}

export function ConsentView({ card, deciding, note, onDecide }: ConsentViewProps): JSX.Element {
  // Взведённая карточка ровно одна: смена карточки снимает взвод в очистке эффекта и ставит паузу заново.
  const [armedId, setArmedId] = useState<string | null>(null);
  const armed = armedId === card.id;
  useEffect(() => {
    const timer = setTimeout(() => setArmedId(card.id), CARD_ARM_MS);
    return () => {
      clearTimeout(timer);
      setArmedId(null);
    };
  }, [card.id]);
  const disabled = deciding || !armed;
  const isSwitch = card.kind === 'agent-switch';
  const who = isSwitch ? card.requestedBy.label : (card.requestedBy.label ?? card.requestedBy.sessionId ?? '—');
  return (
    <div data-testid="island-card" className="island-reveal flex w-[440px] flex-col gap-2 px-3 pb-3 pt-1.5 text-sm">
      <div className="font-semibold text-foreground">{isSwitch ? S.dialogs.agentSwitch.title : S.island.consentTitle}</div>
      {card.kind === 'agent-switch' ? (
        <>
          <div data-testid="island-consent-switch" className="text-sm [overflow-wrap:anywhere]">
            {switchRequestText(card)}
          </div>
          <div className="text-[13px] text-muted-foreground [overflow-wrap:anywhere]">{S.island.consentRequestedBy(who, 'request_agent_switch')}</div>
        </>
      ) : (
        <>
          <div data-testid="island-consent-folder" title={card.folder} className="font-mono text-sm [overflow-wrap:anywhere]">
            {shortenMiddle(card.folder)}
          </div>
          <div className="text-[13px] text-muted-foreground [overflow-wrap:anywhere]">
            {S.island.consentRequestedBy(who, S.island.consentSource[card.requestedBy.source])}
          </div>
        </>
      )}
      {note === 'elsewhere' ? <div className="text-muted-foreground">{S.island.consentAnswered}</div> : null}
      {note === 'failed' ? <div className="text-[var(--status-warning-text)]">{S.island.consentFailed}</div> : null}
      {note === 'done' ? (
        <div data-testid="island-consent-done" className="text-[var(--color-accent)]">
          {S.island.consentDone}
        </div>
      ) : note === 'elsewhere' ? null : (
        <div className="flex flex-wrap gap-2">
          <Button data-testid="island-consent-trust" size="default" className="cursor-pointer text-sm" disabled={disabled} aria-busy={deciding || undefined} onClick={() => onDecide(card.id, 'allow')}>
            {isSwitch ? S.island.consentAllow : S.island.consentTrust}
          </Button>
          <Button data-testid="island-consent-deny" size="default" variant="outline" className="cursor-pointer text-sm" disabled={disabled} onClick={() => onDecide(card.id, 'deny')}>
            {S.island.deny}
          </Button>
        </div>
      )}
    </div>
  );
}
