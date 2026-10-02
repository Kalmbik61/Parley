/** Строка под кнопками карточки после неудачного решения (план 2026-10-01, кусок 4a, решение П). */

import { S } from '../../../shared/strings.js';
import type { CardNote as Note } from '../store.js';

export function CardNote({ note }: { note: Note | null }): JSX.Element | null {
  if (note === null) return null;
  return (
    <p data-testid="card-note" role="alert" className="m-0 text-xs text-[var(--status-warning-text)]">
      {note === 'failed' ? S.chat.card.failed : S.chat.card.notApplied}
    </p>
  );
}
