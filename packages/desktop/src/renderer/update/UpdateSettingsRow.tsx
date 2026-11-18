/**
 * Строка самообновления в Settings → About, под переключателем «Check for updates automatically» (спека self-update §4.2, место — с 0.38):
 * состояние и одна кнопка. Нужна, потому что тост можно смахнуть, а другого входа к обновлению тогда не остаётся.
 * Состояние берёт у main сама (`onUpdateState`): настройки открываются и закрываются, а состояние живёт в main.
 * Нет новой версии (`idle`) — строки нет.
 */

import { useEffect, useState } from 'react';
import type { ParleyBridge, UpdateState } from '../../shared/bridge.js';
import { S } from '../../shared/strings.js';
import { Button } from '../ui/button.js';
import { updatePercent } from './update-notice.js';

interface RowView {
  text: string;
  label: string;
  onClick: () => Promise<void>;
}

function view(bridge: ParleyBridge, state: UpdateState): RowView | null {
  switch (state.phase) {
    case 'idle':
      return null;
    case 'available':
      return state.canInstall
        ? {
            text: S.update.row.available(state.version),
            label: S.update.update,
            onClick: () => bridge.app.downloadUpdate(),
          }
        : {
            text: S.update.row.available(state.version),
            label: S.update.download,
            onClick: () => bridge.app.openExternal(state.url),
          };
    case 'downloading':
      return {
        text: S.update.row.downloading(state.version, updatePercent(state.received, state.total)),
        label: S.update.cancel,
        onClick: () => bridge.app.cancelUpdateDownload(),
      };
    case 'verifying':
      return {
        text: S.update.row.checking(state.version),
        label: S.update.cancel,
        onClick: () => bridge.app.cancelUpdateDownload(),
      };
    case 'ready':
      return {
        text: S.update.row.ready(state.version),
        label: S.update.restartToUpdate,
        onClick: () => bridge.app.installUpdate(),
      };
    case 'failed':
      return {
        text: S.update.row.failed(S.update.failure[state.reason]),
        label: S.update.tryAgain,
        onClick: () => bridge.app.downloadUpdate(),
      };
  }
}

export function UpdateSettingsRow({ bridge }: { bridge: ParleyBridge }): JSX.Element | null {
  const [state, setState] = useState<UpdateState>({ phase: 'idle' });
  useEffect(() => bridge.app.onUpdateState(setState), [bridge]);
  const shown = view(bridge, state);
  if (shown === null) return null;
  return (
    <div className="flex items-center justify-between gap-2 text-sm">
      <span>{shown.text}</span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          shown.onClick().catch((error: unknown) => console.warn('[parley] update', error));
        }}
      >
        {shown.label}
      </Button>
    </div>
  );
}
