/**
 * Согласие человека на папку для агентов (спека 2026-10-21, 4.2): «Trust <папка> for agents?». Один диалог на три места —
 * композер новой работы (папка без записи в `trust.json`), карточка согласия, которую хост держит за запуск Codex
 * (`ConsentPrompt`), и кнопка «Trust folder» в Chat. Путь в заголовке сокращается по середине (`shortenMiddle`), полный —
 * во всплывающей подсказке. `requestedBy` — кто просил («S03 Ruslan · create_session»): только у карточки хоста.
 *
 * Построен на `ConfirmDialog`, который зовёт `onOpenChange(false)` и после подтверждения: отменой считается только
 * закрытие без «Trust».
 */

import { useEffect, useRef } from 'react';
import { S } from '../../../shared/strings.js';
import { shortenMiddle } from '../../lib/shorten-middle.js';
import { ConfirmDialog } from './ConfirmDialog.js';

export interface TrustFolderDialogProps {
  open: boolean;
  /** Папка проекта: путь, как его знает окно (хост запишет её realpath). */
  folder: string;
  /** Кто просил, готовой строкой; нет — строки «Requested by …» нет. */
  requestedBy?: string;
  onTrust: () => void;
  /** «Cancel», Esc и закрытие крестиком. */
  onCancel: () => void;
}

export function TrustFolderDialog({ open, folder, requestedBy, onTrust, onCancel }: TrustFolderDialogProps): JSX.Element {
  const text = S.dialogs.trustFolder;
  // «Trust» тоже заканчивается `onOpenChange(false)`: без флага за подтверждением шла бы отмена.
  const trusted = useRef(false);
  useEffect(() => {
    if (open) trusted.current = false;
  }, [open]);

  return (
    <ConfirmDialog
      open={open}
      title={text.title(shortenMiddle(folder))}
      titleHint={folder}
      description={requestedBy === undefined ? text.body : `${text.requestedBy(requestedBy)} ${text.body}`}
      confirmLabel={text.confirm}
      confirmVariant="default"
      onConfirm={() => {
        trusted.current = true;
        onTrust();
      }}
      onOpenChange={(next) => {
        if (!next && !trusted.current) onCancel();
      }}
    />
  );
}
