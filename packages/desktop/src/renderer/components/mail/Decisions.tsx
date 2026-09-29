/**
 * Блок решений — «вся почта работы» и лента комнаты (спека 5.1, 6.3; облик — спека окна 2026-09-29, 1.3):
 * до пяти последних, каждое — не длиннее двух строк (`line-clamp-2`, встроенный в Tailwind с 3.3, плагин не
 * нужен) — полный текст решения всё равно виден в самой ленте ниже. Старше показанных — строкой «+N
 * раньше» (перенос счёта `older` из `tui/src/room-view.ts#roomView`).
 *
 * Плашка Organic: фон `accent-2-500 14 %`, radius 16, padding `12 16`, подпись 11px/600 капсом с
 * разрядкой .06em вторичным цветом, пункты 13px/1.5 `{текст} · {отправитель}`. Раскладку задаёт вызывающий
 * (`className`): в «Почте» плашка стоит в колонке ленты с отступом 36 и шириной до 640px, в комнате — первой
 * в самой ленте, до 680px.
 */

import { S } from '../../../shared/strings.js';
import { cn } from '../../lib/cn.js';

export interface DecisionsProps {
  /** Письма вида `decision`: подходит и `LetterView` «Почты», и запись модели комнаты. */
  decisions: { shown: ReadonlyArray<{ id: string; text: string; from: string }>; earlier: number };
  className?: string;
}

export function Decisions({ decisions, className }: DecisionsProps): JSX.Element | null {
  if (decisions.shown.length === 0) return null;

  return (
    <div
      data-decisions=""
      className={cn(
        'flex shrink-0 flex-col gap-1.5 rounded-md bg-[color-mix(in_srgb,var(--color-accent-2-500)_14%,transparent)] px-4 py-3 text-foreground',
        className,
      )}
    >
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
