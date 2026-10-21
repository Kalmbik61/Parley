/**
 * Знак «?» у подписи поля диалогов «New session or room» и «New workspace»: по наведению — что это за поле
 * (тексты — `S.dialogs.newSession.hints`).
 */

import { CircleHelp } from 'lucide-react';
import { S } from '../../../shared/strings.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip.js';

/**
 * Знак «?» у подписи поля. Вне порядка Tab: иначе автофокус диалога попадал бы на «?»
 * у рецепта и открывал его подсказку сразу при открытии. Клик подсказку не закрывает (Radix закрывает тултип по нажатию
 * на триггер, а «?» нажимают как раз чтобы прочитать): свой `preventDefault` отменяет обработчик Radix.
 */
export function FieldHint({ field, text }: { field: string; text: string }): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          tabIndex={-1}
          aria-label={S.dialogs.newSession.hintLabel(field)}
          onPointerDown={(event) => event.preventDefault()}
          onClick={(event) => event.preventDefault()}
          className="inline-flex size-4 shrink-0 cursor-help items-center justify-center rounded-full text-neutral-600 hover:text-foreground"
        >
          <CircleHelp className="size-[13px]" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-[300px] whitespace-pre-line leading-snug">{text}</TooltipContent>
    </Tooltip>
  );
}

/** Подпись поля со знаком «?» рядом. */
export function FieldCaption({ text, hint }: { text: string; hint: string }): JSX.Element {
  return (
    <span className="flex min-w-0 items-center gap-1">
      {text}
      <FieldHint field={text} text={hint} />
    </span>
  );
}
