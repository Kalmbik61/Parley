/**
 * Вложение «Chat» одним чипом: картинка с готовой миниатюрой (`use-thumbnail.ts`) — самой миниатюрой, всё
 * прочее и картинка без миниатюры (грузится, файла уже нет, больше 20 МБ) — значком и именем файла; полный
 * путь — в `title`. Тот же чип стоит над полем ввода (с крестиком) и в пузыре промпта ленты (без него).
 * Рамка миниатюры фиксированного размера: высота строки виртуального списка не зависит от пропорций
 * картинки. Длинное имя режется многоточием, а не раздвигает поле и пузырь.
 */

import { FileText, ImageIcon, X } from 'lucide-react';
import type { ParleyBridge } from '../../shared/bridge.js';
import { isImagePath } from '../../shared/image-path.js';
import { S } from '../../shared/strings.js';
import { cn } from '../lib/cn.js';
import { useThumbnail } from './use-thumbnail.js';

export interface AttachmentChipProps {
  path: string;
  /** Откуда берётся миниатюра; `null` — моста нет (элемент вне окружения ленты), чип без картинки. */
  bridge: ParleyBridge | null;
  /** `composer` — над полем ввода (миниатюра 56×56), `feed` — в пузыре промпта (160×120). */
  size: 'composer' | 'feed';
  /** Есть — у чипа кнопка «убрать»: так стоит чип над полем ввода. */
  onRemove?: () => void;
}

/** Имя файла из пути: разделители `/` и `\`, хвостовой разделитель не в счёт. */
function fileName(path: string): string {
  return path.split(/[\\/]/).filter((part) => part !== '').at(-1) ?? path;
}

export function AttachmentChip({ path, bridge, size, onRemove }: AttachmentChipProps): JSX.Element {
  const name = fileName(path);
  const image = isImagePath(path);
  const thumbnail = useThumbnail(bridge, image ? path : null);
  const label = S.chat.composer.removeAttachment(name);

  if (thumbnail !== null) {
    return (
      <div
        data-testid="chat-attachment"
        data-path={path}
        data-thumbnail=""
        className={cn(
          'relative max-w-full shrink-0 overflow-hidden rounded-md border border-border bg-muted',
          size === 'feed' ? 'h-[120px] w-[160px]' : 'size-14',
        )}
      >
        <img src={thumbnail} alt={name} title={path} className="size-full object-cover" />
        {onRemove === undefined ? null : (
          <button
            type="button"
            aria-label={label}
            title={label}
            onClick={onRemove}
            className="absolute right-1 top-1 flex size-[18px] items-center justify-center rounded-full bg-background/85 text-foreground transition-colors hover:bg-background"
          >
            <X className="size-3" aria-hidden="true" />
          </button>
        )}
      </div>
    );
  }

  const Icon = image ? ImageIcon : FileText;
  return (
    <div
      data-testid="chat-attachment"
      data-path={path}
      title={path}
      className="inline-flex min-w-0 max-w-[min(16rem,100%)] items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
    >
      <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 truncate">{name}</span>
      {onRemove === undefined ? null : (
        <button
          type="button"
          aria-label={label}
          title={label}
          onClick={onRemove}
          className="flex size-[18px] shrink-0 items-center justify-center rounded-full transition-colors hover:bg-foreground/12"
        >
          <X className="size-3" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
