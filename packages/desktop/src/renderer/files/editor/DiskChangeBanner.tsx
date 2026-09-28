/**
 * Баннер над редактором (кусок 7.3b, спека 10.5) — по `bufferView` буфера. Правка агента на диске
 * при правках человека молча не применяется и не перетирается: решает человек.
 * - `disk-changed-dirty` — «File changed on disk (probably by the agent)»: Reload (мои правки
 *   пропадут), Compare, Keep mine (баннер закрыт, следующее ⌘S спросит);
 * - `deleted` — «File deleted on disk»: Save again (создаёт файл заново) и Close.
 * Прочим состояниям баннера нет: `disk-changed-clean` перезагружается тихо.
 */

import { TriangleAlert } from 'lucide-react';
import { S } from '../../../shared/strings.js';
import { Button } from '../../ui/button.js';
import { bufferView, type BufferModel } from '../buffer.js';

export interface DiskChangeBannerProps {
  model: BufferModel;
  /** Уже в сравнении — кнопки «Compare» нет. */
  comparing?: boolean;
  onReload(): void;
  onCompare(): void;
  onKeepMine(): void;
  onSaveAgain(): void;
  onClose(): void;
}

export function DiskChangeBanner({ model, comparing = false, onReload, onCompare, onKeepMine, onSaveAgain, onClose }: DiskChangeBannerProps): JSX.Element | null {
  const { banner } = bufferView(model, Date.now());
  if (banner === 'none') return null;
  const text = banner === 'deleted' ? S.files.deletedOnDisk : S.files.changedOnDisk;
  return (
    <div
      role="status"
      data-testid="disk-change-banner"
      data-banner={banner}
      className="flex min-w-0 shrink-0 flex-wrap items-center gap-2 border-b border-status-warning-border bg-status-warning-background px-3 py-1.5 text-xs text-foreground"
    >
      <TriangleAlert aria-hidden className="size-3.5 shrink-0 text-status-warning" />
      <span className="min-w-0 flex-1 truncate" title={text}>
        {text}
      </span>
      <div className="flex shrink-0 gap-1">
        {banner === 'deleted' ? (
          <>
            <Button type="button" size="sm" variant="outline" onClick={onSaveAgain}>
              {S.files.saveAgain}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={onClose}>
              {S.common.close}
            </Button>
          </>
        ) : (
          <>
            <Button type="button" size="sm" variant="outline" onClick={onReload}>
              {S.files.reload}
            </Button>
            {comparing ? null : (
              <Button type="button" size="sm" variant="outline" onClick={onCompare}>
                {S.files.compare}
              </Button>
            )}
            <Button type="button" size="sm" variant="ghost" onClick={onKeepMine}>
              {S.files.keepMine}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
