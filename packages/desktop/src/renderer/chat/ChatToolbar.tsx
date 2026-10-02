/**
 * Тулбар вкладки сессии (план 2026-10-01, Task 3, п. 4): сегмент «Chat | Terminal». Есть в обоих
 * видах — в терминале он над поверхностью (`TerminalSurface` с отступом `TAB_TOOLBAR_PX`), иначе
 * вернуться в чат можно было бы только палитрой. Выбор пишется полем `view` вкладки в раскладку и
 * переживает перезапуск. Вид «Chat» сессии недоступен (Codex, старый `claude`) — сегмент выключен с
 * подсказкой. Режим, модель и Stop — следующие подкуски.
 */

import type { TerminalView } from '../../shared/layout-types.js';
import { S } from '../../shared/strings.js';
import { useLayoutStore } from '../layout/store.js';
import { updateTab } from '../layout/tree.js';
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group.js';

/** Высота тулбара: на столько поверхность терминала опускается под ним. */
export const TAB_TOOLBAR_PX = 36;

export interface ChatToolbarProps {
  workKey: string;
  tabId: string;
  /** Вид, который вкладка показывает сейчас (`effectiveView`). */
  view: TerminalView;
  /** Вид «Chat» доступен сессии; нет — сегмент выключен. */
  available: boolean;
}

const ITEM = 'h-6 whitespace-nowrap px-2.5 text-xs';

export function ChatToolbar({ workKey, tabId, view, available }: ChatToolbarProps): JSX.Element {
  const choose = (value: string): void => {
    // Повторный клик по выбранному снял бы выбор: пустое значение пропускаем.
    if (value !== 'chat' && value !== 'terminal') return;
    useLayoutStore.getState().apply(workKey, (layout) => updateTab(layout, tabId, { view: value }));
  };
  return (
    <div
      data-testid="chat-toolbar"
      className="flex min-w-0 shrink-0 items-center gap-2 border-b border-border px-2"
      style={{ height: TAB_TOOLBAR_PX }}
    >
      {/* `title` — на обёртке: у выключенных кнопок нет событий указателя, подсказка не всплыла бы. */}
      <span title={available ? undefined : S.chat.terminalOnly} className="inline-flex">
        <ToggleGroup
          type="single"
          size="sm"
          aria-label={S.chat.viewLabel}
          value={view}
          disabled={!available}
          onValueChange={choose}
        >
          <ToggleGroupItem value="chat" className={ITEM}>
            {S.chat.segment.chat}
          </ToggleGroupItem>
          <ToggleGroupItem value="terminal" className={ITEM}>
            {S.chat.segment.terminal}
          </ToggleGroupItem>
        </ToggleGroup>
      </span>
    </div>
  );
}
