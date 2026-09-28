/**
 * Карточка выбранного элемента (кусок 9.3b, спека 12.3, п. 7) поверх страницы вкладки браузера:
 * миниатюра, селектор, текст в две строки и три действия — «Send to agent ▾», «Copy», «Pick again».
 *
 * Отправка — только выбором человека (спека 15.1, п. 9): `SendMenu` (8.4b) зовёт `onSend` лишь по
 * нажатию. Сессия по умолчанию — `focusedSessionOf` работы (7.2): сессии диффа у карточки нет. Исход
 * и повтор — тост `sendWithToast` (5.4, таблица спеки 8.6); сама карточка ничего не повторяет.
 *
 * Миниатюра — `data:image/png` из main: PNG в `drops/` лежит вне корней работы, а `file://` окну
 * запрещён.
 */

import type { WorkEntry } from '@harnas/core';
import type { PickResult } from '../../shared/browser-types.js';
import { S } from '../../shared/strings.js';
import { focusedSessionOf, useLayoutStore } from '../layout/store.js';
import { SendMenu } from '../review/notes/SendMenu.js';
import { sendWithToast, type SendWithToastDeps } from '../terminal/send.js';
import { designBlock } from './design-block.js';

export interface DesignModeCardProps {
  workKey: string;
  entry: WorkEntry; // сессии работы — SendMenu
  result: PickResult;
  sendDeps: SendWithToastDeps; // окна, из AppShell через SurfaceLayer (7.2)
  onPickAgain(): void;
}

const ACTION =
  'h-6 shrink-0 rounded-md border border-border bg-background px-2 text-xs text-foreground hover:bg-accent hover:text-accent-foreground';

export function DesignModeCard({ workKey, entry, result, sendDeps, onPickAgain }: DesignModeCardProps): JSX.Element {
  // Снимок на рендер, без подписки: смена фокуса вкладок перерисует карточку через свою поверхность.
  const defaultSessionId = focusedSessionOf(useLayoutStore.getState(), workKey);

  const send = (sessionId: string): void => {
    const ref = { projectPath: entry.projectPath, workId: entry.map.work.id, sessionId };
    void sendWithToast(sendDeps, ref, designBlock(result), true);
  };

  const copy = (): void => {
    navigator.clipboard.writeText(designBlock(result)).catch((error: unknown) => console.warn('[harnas] clipboard', error));
  };

  return (
    <div
      data-testid="design-mode-card"
      className="absolute bottom-3 right-3 z-10 flex w-80 max-w-[calc(100%-24px)] flex-col gap-2 rounded-lg border border-border bg-card p-2.5 text-xs text-card-foreground shadow-lg"
    >
      {result.thumbnail !== null ? (
        <img src={result.thumbnail} alt="" className="max-h-32 w-full rounded border border-border object-contain object-left-top" />
      ) : null}
      <div className="truncate font-mono text-[11px]" title={result.selector}>
        {result.selector}
      </div>
      {result.text !== '' ? <div className="line-clamp-2 break-words text-muted-foreground">{result.text}</div> : null}
      <div className="flex min-w-0 items-center gap-1.5">
        <SendMenu entry={entry} defaultSessionId={defaultSessionId} label={S.browser.sendToAgent} onSend={send} />
        <button type="button" onClick={copy} className={ACTION}>
          {S.common.copy}
        </button>
        <button type="button" onClick={onPickAgain} className={ACTION}>
          {S.browser.pickAgain}
        </button>
      </div>
    </div>
  );
}
