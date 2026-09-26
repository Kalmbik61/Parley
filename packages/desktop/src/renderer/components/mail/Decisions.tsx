/**
 * Блок решений сверху ленты «вся почта работы» (спека 5.1, 6.3): до пяти
 * последних, каждое — не длиннее двух строк (`line-clamp-2`, встроенный в
 * Tailwind с 3.3, плагин не нужен) — полный текст решения всё равно виден в
 * самой ленте ниже. Старше показанных — строкой «+N раньше» (перенос счёта
 * `older` из `tui/src/room-view.ts#roomView`).
 */

import type { LetterView } from '../../lib/mail-view.js';

export interface DecisionsProps {
  decisions: { shown: LetterView[]; earlier: number };
}

export function Decisions({ decisions }: DecisionsProps): JSX.Element | null {
  if (decisions.shown.length === 0) return null;

  return (
    <div className="border-b border-[var(--h-overlay)] px-3 py-2">
      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--h-muted)]">Решения</div>
      {decisions.earlier > 0 ? (
        <div className="mb-1 text-xs text-[var(--h-muted)]">+{decisions.earlier} раньше</div>
      ) : null}
      <ul className="flex flex-col gap-1">
        {decisions.shown.map((decision) => (
          <li key={decision.id} className="line-clamp-2 text-sm text-[var(--h-text)]">
            <span className="text-[var(--h-muted)]">{decision.from}: </span>
            {decision.text}
          </li>
        ))}
      </ul>
    </div>
  );
}
