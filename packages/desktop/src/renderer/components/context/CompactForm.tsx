/**
 * Форма сжатия одной сессии (спека 2026-10-15, 3.2): поле с готовой инструкцией, Compact / Cancel. Текст живёт, пока
 * открыт поповер: форма монтируется заново при каждом открытии. У Codex поле неактивно — его `/compact` без фокуса.
 */

import { useState } from 'react';
import type { CompactionPhase } from '@parley/protocol';
import { S } from '../../../shared/strings.js';
import { COMPACT_MAX_INSTRUCTIONS } from '../../lib/context-format.js';
import { Button } from '../../ui/button.js';
import { Textarea } from '../../ui/textarea.js';

const C = S.context;

export interface CompactFormProps {
  provider: string;
  defaultText: string;
  phase: CompactionPhase | null;
  onCompact: (instructions: string | null) => void;
  onCancel: () => void;
}

export function CompactForm({ provider, defaultText, phase, onCompact, onCancel }: CompactFormProps): JSX.Element {
  const codex = provider === 'codex';
  const [text, setText] = useState(defaultText);
  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">{C.instructionsLabel}</span>
        <Textarea
          data-testid="compact-instructions"
          value={codex ? '' : text}
          disabled={codex}
          maxLength={COMPACT_MAX_INSTRUCTIONS}
          rows={4}
          onChange={(event) => setText(event.target.value)}
          className="resize-none text-xs"
        />
      </label>
      {codex ? <p className="m-0 text-muted-foreground">{C.codexNoFocus}</p> : null}
      <div className="flex justify-end">
        {phase === 'pending' ? (
          <Button type="button" size="xs" variant="outline" data-testid="compact-cancel" onClick={onCancel}>
            {C.cancel}
          </Button>
        ) : (
          <Button
            type="button"
            size="xs"
            data-testid="compact-submit"
            disabled={phase === 'running'}
            onClick={() => onCompact(codex || text.trim() === '' ? null : text)}
          >
            {phase === 'running' ? C.compacting : C.compact}
          </Button>
        )}
      </div>
    </div>
  );
}
