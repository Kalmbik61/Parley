/**
 * «Попросить агента разрешить» (кусок 8.2b, спека 11.2, решение сверки I2): текст агенту виден
 * и правится до отправки, получатель — сессия worktree. Отправка — только кнопкой «Send», одна
 * на нажатие: `sendWithToast` (5.4) с `submit: true`, тосты — таблица спеки 8.6, повтор — только
 * `Retry` тоста.
 *
 * Проп сессии — `sessionRef`, а не `ref` плана: в React 18 `ref` до функционального компонента
 * не доходит (его забирает сам React).
 */

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { SessionRef } from '@parley/protocol';
import { S } from '../../shared/strings.js';
import { sessionTag } from '../lib/participant.js';
import { sendWithToast, type SendWithToastDeps } from '../terminal/send.js';
import { Button } from '../ui/button.js';
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTitle } from '../ui/dialog.js';
import { Textarea } from '../ui/textarea.js';
import { fitsSendLimit } from './state.js';

export interface AskAgentDialogProps {
  open: boolean;
  /** Сессия worktree — получатель. */
  sessionRef: SessionRef;
  /** askAgentText (8.2a). */
  initialText: string;
  sendDeps: SendWithToastDeps;
  onOpenChange(open: boolean): void;
}

export function AskAgentDialog({ open, sessionRef, initialText, sendDeps, onOpenChange }: AskAgentDialogProps): JSX.Element {
  const [text, setText] = useState(initialText);
  // Одна отправка на одно открытие (раунд 8, пункт 3) — как `confirmed` у ConfirmDialog: «Send»
  // остаётся в DOM на время анимации закрытия, а `pty.send` не идемпотентен — второй клик вставил
  // бы агенту тот же текст ещё раз.
  const sent = useRef(false);
  // Каждое открытие — свежий шаблон: список конфликтов мог смениться с прошлого раза.
  useEffect(() => {
    if (open) {
      setText(initialText);
      sent.current = false;
    }
  }, [open, initialText]);

  const send = (): void => {
    if (sent.current) return;
    if (!fitsSendLimit(text)) {
      // Хост ответил бы bad_request, и тост сказал бы только «failed»: предел — до вызова.
      toast.error(S.send.tooLong);
      return;
    }
    sent.current = true;
    onOpenChange(false);
    void sendWithToast(sendDeps, sessionRef, text, true);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="max-w-xl">
        <DialogTitle>{S.changes.askAgentTitle(sessionTag(sessionRef.sessionId))}</DialogTitle>
        <Textarea
          className="min-h-48 font-mono text-xs"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="ghost">
              {S.common.cancel}
            </Button>
          </DialogClose>
          <Button type="button" disabled={text.trim() === ''} onClick={send}>
            {S.common.send}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
