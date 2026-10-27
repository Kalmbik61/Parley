/**
 * Строка действий под сообщением Chat (спека 2026-10-16, 3.1): Copy у своего сообщения и у куска ответа модели,
 * Send again — у своего, Reply — у ответа модели (цитата над полем ввода, `chat/reply.ts`). Нажатие Reply не снимает
 * выделение текста (`mousedown` погашен): выделенный фрагмент и цитируется. Видна при наведении и при фокусе внутри сообщения (родитель с классом `group`); место под
 * неё есть всегда, скрыта она прозрачностью — лента виртуализирована, и высота строки не должна меняться от наведения.
 * После Copy на `COPIED_MS` вместо значка — галочка с подписью «Copied»; отказ буфера — только в консоль.
 */

import { useEffect, useState } from 'react';
import { Check, Copy, Reply, RotateCcw } from 'lucide-react';
import { S } from '../../../shared/strings.js';
import { cn } from '../../lib/cn.js';
import { Button } from '../../ui/button.js';

/** Сколько держится галочка после Copy. */
export const COPIED_MS = 1500;

export interface MessageActionsProps {
  /** Что кладёт Copy в буфер. */
  copyText: string;
  /** Есть — кнопка Send again. */
  onSendAgain?: () => void;
  /** Есть — кнопка Reply. */
  onReply?: () => void;
  align: 'start' | 'end';
}

export function MessageActions({ copyText, onSendAgain, onReply, align }: MessageActionsProps): JSX.Element {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = (): void => {
    navigator.clipboard.writeText(copyText).then(
      () => setCopied(true),
      (error: unknown) => console.warn('[parley] clipboard', error),
    );
  };
  const copyLabel = copied ? S.chat.actions.copied : S.chat.actions.copy;
  return (
    <div
      data-testid="chat-message-actions"
      className={cn(
        'flex h-6 items-center gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 motion-reduce:transition-none',
        align === 'end' ? 'justify-end' : 'justify-start',
      )}
    >
      <Button type="button" size="icon-xs" variant="ghost" aria-label={copyLabel} title={copyLabel} onClick={copy}>
        {copied ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
      </Button>
      {onReply === undefined ? null : (
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label={S.chat.actions.reply}
          title={S.chat.actions.reply}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onReply}
        >
          <Reply className="size-3.5" aria-hidden="true" />
        </Button>
      )}
      {onSendAgain === undefined ? null : (
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label={S.chat.actions.sendAgain}
          title={S.chat.actions.sendAgain}
          onClick={onSendAgain}
        >
          <RotateCcw className="size-3.5" aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}
