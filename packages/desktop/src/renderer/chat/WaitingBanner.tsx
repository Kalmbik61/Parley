/**
 * Баннер над полем ввода вида «Chat» (план 2026-10-01, кусок 4a, решение Н): агент ждёт человека в
 * терминале — диалог без хука (доверие папке, вход, elicitation). Кнопка уводит вкладку в терминал,
 * как сегмент тулбара. Показывает его `ChatView`; здесь только вид и переход.
 */

import { S } from '../../shared/strings.js';
import { useLayoutStore } from '../layout/store.js';
import { updateTab } from '../layout/tree.js';
import { Button } from '../ui/button.js';

export interface WaitingBannerProps {
  workKey: string;
  tabId: string;
}

export function WaitingBanner({ workKey, tabId }: WaitingBannerProps): JSX.Element {
  const openTerminal = (): void => {
    useLayoutStore.getState().apply(workKey, (layout) => updateTab(layout, tabId, { view: 'terminal' }));
  };
  return (
    <div
      data-testid="chat-waiting-banner"
      role="status"
      className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-1.5 text-xs text-muted-foreground"
    >
      <span className="min-w-0 flex-1 truncate">{S.chat.waitingBanner.text}</span>
      <Button type="button" size="xs" variant="outline" data-testid="chat-waiting-open" onClick={openTerminal} className="shrink-0">
        {S.chat.waitingBanner.open}
      </Button>
    </div>
  );
}
