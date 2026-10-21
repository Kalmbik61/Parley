/**
 * Промпт человека в ленте (план 2026-10-01, решение 3): справа, на подложке. Число картинок — из
 * журнала (хуки картинок не отдают). Серый вариант (`queued`) — сообщение, отправленное во время хода:
 * оно ждёт в очереди CLI, пока не придёт настоящий промпт с тем же текстом (решение 8).
 *
 * Хвостовые упоминания `@"путь"` — вложения, которые окно дописало при отправке (`attachments.ts`): в
 * пузыре они над текстом чипами (картинка — миниатюрой), самих путей в тексте нет. Снимок файла-контекста
 * браузера с тем же именем, что у его `.md`, отдельным чипом не показывается: его миниатюра — в чипе `.md`.
 *
 * Очередь окна (спека 2026-10-16, 4.3): серый элемент бывает трёх видов — `queued` (уже в очереди CLI во время хода),
 * `waiting` (ждёт отправки окном: пока не ушло, у него «Send now» и ×; в полёте — «Sending…») и `failed` («Not sent» с Retry и ×). У всех `data-testid="chat-queued"` и `data-state`.
 *
 * Под настоящим промптом — Copy и Send again (`MessageActions`, спека 2026-10-16, 3.1): Copy кладёт текст как
 * ушёл, с упоминаниями `@"путь"`, без пустых краёв; Send again ставит его как есть в очередь отправки.
 */

import { useContext } from 'react';
import { ImageIcon, X } from 'lucide-react';
import { S } from '../../../shared/strings.js';
import { cn } from '../../lib/cn.js';
import { Button } from '../../ui/button.js';
import { AssistantMark } from '../../components/AssistantMark.js';
import { AttachmentChip } from '../AttachmentChip.js';
import { splitAttachments } from '../attachments.js';
import { ChatEnvContext } from '../chat-env.js';
import { pairContextAttachments } from '../context-attachments.js';
import { MessageActions } from './MessageActions.js';

export interface PromptItemProps {
  text: string;
  images?: number;
  /** Серый элемент: `queued` — в очереди CLI, `waiting` — ждёт отправки окном, `failed` — не ушло. Нет — настоящий промпт. */
  state?: 'queued' | 'waiting' | 'failed';
  /** `failed`: Retry. */
  onRetry?: () => void;
  /** `waiting`: «Send now» — отдать в CLI, не дожидаясь конца хода. */
  onSendNow?: () => void;
  /** `waiting` (не в полёте) и `failed`: × — убрать не ушедшее. */
  onRemove?: () => void;
  /** Сообщение отправил помощник (спека 2026-10-14, 7.4): над пузырём «via assistant». */
  via?: boolean;
}

export function PromptItem({ text, images = 0, state, onRetry, onSendNow, onRemove, via }: PromptItemProps): JSX.Element {
  // Мост — только для миниатюр: `useChatEnv()` вне окружения бросает, а промпт без него рисуется (чипы без картинок).
  const env = useContext(ChatEnvContext);
  const bridge = env?.bridge ?? null;
  const resend = env?.resend;
  // Вставка в CLI оставляет в промпте пустые строки по краям — в пузыре они только место.
  const { text: body, attachments } = splitAttachments(text);
  const shown = pairContextAttachments(attachments);
  const grey = state !== undefined;
  return (
    <div
      data-testid={grey ? 'chat-queued' : 'chat-prompt'}
      {...(grey ? { 'data-state': state } : {})}
      className={cn('flex min-w-0 flex-col items-end', !grey && 'group gap-0.5')}
    >
      {via === true ? (
        <div className="flex items-center justify-end gap-1 text-[12px] text-muted-foreground">
          <AssistantMark size={12} />
          {S.chat.viaAssistant}
        </div>
      ) : null}
      <div
        className={cn(
          'flex min-w-0 max-w-[85%] flex-col gap-1 rounded-md px-3 py-2 text-sm',
          grey ? 'border border-dashed border-border text-muted-foreground' : 'bg-secondary text-secondary-foreground',
        )}
      >
        {shown.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            {shown.map((path, index) => (
              <AttachmentChip key={`${index}:${path}`} path={path} bridge={bridge} size="feed" />
            ))}
          </div>
        ) : null}
        {body === '' ? null : <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{body}</span>}
        {images > 0 ? (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <ImageIcon className="size-3.5" aria-hidden="true" />
            {S.chat.images(images)}
          </span>
        ) : null}
        {state === 'queued' ? <span className="text-xs">{S.chat.queued}</span> : null}
        {state === 'waiting' && onSendNow === undefined && onRemove === undefined ? <span className="text-xs">{S.outbox.sending}</span> : null}
        {state === 'waiting' && (onSendNow !== undefined || onRemove !== undefined) ? (
          <span className="flex items-center gap-2 text-xs">
            <span>{S.chat.queued}</span>
            <Button type="button" size="xs" variant="outline" onClick={onSendNow}>
              {S.outbox.sendNow}
            </Button>
            <Button type="button" size="icon-xs" variant="ghost" aria-label={S.outbox.remove} title={S.outbox.remove} onClick={onRemove}>
              <X className="size-3.5" aria-hidden="true" />
            </Button>
          </span>
        ) : null}
        {state === 'failed' ? (
          <span className="flex items-center gap-2 text-xs">
            <span className="text-[var(--status-warning-text)]">{S.outbox.notSent}</span>
            <Button type="button" size="xs" variant="outline" onClick={onRetry}>
              {S.common.retry}
            </Button>
            <Button type="button" size="icon-xs" variant="ghost" aria-label={S.outbox.remove} title={S.outbox.remove} onClick={onRemove}>
              <X className="size-3.5" aria-hidden="true" />
            </Button>
          </span>
        ) : null}
      </div>
      {grey ? null : (
        <MessageActions copyText={text.trim()} align="end" {...(resend === undefined ? {} : { onSendAgain: () => resend(text) })} />
      )}
    </div>
  );
}
