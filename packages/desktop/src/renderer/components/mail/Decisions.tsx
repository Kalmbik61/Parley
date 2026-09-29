/**
 * Блок решений сверху ленты «вся почта работы» (спека 5.1, 6.3): до пяти
 * последних, каждое — не длиннее двух строк (`line-clamp-2`, встроенный в
 * Tailwind с 3.3, плагин не нужен) — полный текст решения всё равно виден в
 * самой ленте ниже. Старше показанных — строкой «+N раньше» (перенос счёта
 * `older` из `tui/src/room-view.ts#roomView`).
 *
 * Два вида, как у `Letter`: `card` — плашка Organic (спека окна 2026-09-29, 1.3): фон `accent-2-500 14 %`,
 * radius 16, подпись 11px/600 капсом с разрядкой .06em вторичным цветом, пункты 13px/1.5 `{текст} · {отправитель}`;
 * во вкладке «Почта» она стоит в колонке ленты (отступ 36, до 640px). `plain` — прежняя разметка ленты комнаты,
 * которую перекрасит кусок 6.
 */

import { S } from '../../../shared/strings.js';
import type { LetterView } from '../../lib/mail-view.js';

export interface DecisionsProps {
  decisions: { shown: LetterView[]; earlier: number };
  variant?: 'card' | 'plain';
}

export function Decisions({ decisions, variant = 'plain' }: DecisionsProps): JSX.Element | null {
  if (decisions.shown.length === 0) return null;

  if (variant === 'card') {
    return (
      <div className="mx-9 mb-3.5 flex max-w-[640px] shrink-0 flex-col gap-1.5 rounded-md bg-[color-mix(in_srgb,var(--color-accent-2-500)_14%,transparent)] px-4 py-3 text-foreground">
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">{S.mail.decisionsHeading}</div>
        {decisions.earlier > 0 ? <div className="text-xs text-muted-foreground">{S.mail.decisionsEarlier(decisions.earlier)}</div> : null}
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {decisions.shown.map((decision) => (
            <li key={decision.id} className="line-clamp-2 break-words text-[13px] leading-[1.5]">
              {decision.text}
              <span className="text-muted-foreground"> · {decision.from}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="border-b border-border px-3 py-2">
      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {S.mail.decisionsHeading}
      </div>
      {decisions.earlier > 0 ? (
        <div className="mb-1 text-xs text-muted-foreground">{S.mail.decisionsEarlier(decisions.earlier)}</div>
      ) : null}
      <ul className="flex flex-col gap-1">
        {decisions.shown.map((decision) => (
          <li key={decision.id} className="line-clamp-2 text-sm text-foreground">
            <span className="text-muted-foreground">{decision.from}: </span>
            {decision.text}
          </li>
        ))}
      </ul>
    </div>
  );
}
