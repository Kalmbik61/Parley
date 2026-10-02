/**
 * Промпт человека в ленте (план 2026-10-01, решение 3): справа, на подложке. Число картинок — из
 * журнала (хуки картинок не отдают). Серый вариант (`queued`) — сообщение, отправленное во время хода:
 * оно ждёт в очереди CLI, пока не придёт настоящий промпт с тем же текстом (решение 8).
 *
 * Хвостовые упоминания `@"путь"` — вложения, которые окно дописало при отправке (`attachments.ts`): в
 * пузыре они над текстом чипами (картинка — миниатюрой), самих путей в тексте нет.
 */

import { useContext } from 'react';
import { ImageIcon } from 'lucide-react';
import { S } from '../../../shared/strings.js';
import { cn } from '../../lib/cn.js';
import { AttachmentChip } from '../AttachmentChip.js';
import { splitAttachments } from '../attachments.js';
import { ChatEnvContext } from '../chat-env.js';

export interface PromptItemProps {
  text: string;
  images?: number;
  queued?: boolean;
}

export function PromptItem({ text, images = 0, queued = false }: PromptItemProps): JSX.Element {
  // Мост — только для миниатюр: `useChatEnv()` вне окружения бросает, а промпт без него рисуется (чипы без картинок).
  const bridge = useContext(ChatEnvContext)?.bridge ?? null;
  // Вставка в CLI оставляет в промпте пустые строки по краям — в пузыре они только место.
  const { text: body, attachments } = splitAttachments(text);
  return (
    <div data-testid={queued ? 'chat-queued' : 'chat-prompt'} className="flex min-w-0 justify-end">
      <div
        className={cn(
          'flex min-w-0 max-w-[85%] flex-col gap-1 rounded-md px-3 py-2 text-sm',
          queued ? 'border border-dashed border-border text-muted-foreground' : 'bg-secondary text-secondary-foreground',
        )}
      >
        {attachments.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            {attachments.map((path, index) => (
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
        {queued ? <span className="text-xs">{S.chat.queued}</span> : null}
      </div>
    </div>
  );
}
