/**
 * Промпт человека в ленте (план 2026-10-01, решение 3): справа, на подложке. Число картинок — из
 * журнала (хуки картинок не отдают). Серый вариант (`queued`) — сообщение, отправленное во время хода:
 * оно ждёт в очереди CLI, пока не придёт настоящий промпт с тем же текстом (решение 8).
 */

import { ImageIcon } from 'lucide-react';
import { S } from '../../../shared/strings.js';
import { cn } from '../../lib/cn.js';

export interface PromptItemProps {
  text: string;
  images?: number;
  queued?: boolean;
}

export function PromptItem({ text, images = 0, queued = false }: PromptItemProps): JSX.Element {
  return (
    <div data-testid={queued ? 'chat-queued' : 'chat-prompt'} className="flex min-w-0 justify-end">
      <div
        className={cn(
          'flex min-w-0 max-w-[85%] flex-col gap-1 rounded-md px-3 py-2 text-sm',
          queued ? 'border border-dashed border-border text-muted-foreground' : 'bg-secondary text-secondary-foreground',
        )}
      >
        {/* Вставка в CLI оставляет в промпте пустые строки по краям — в пузыре они только место. */}
        <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{text.trim()}</span>
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
