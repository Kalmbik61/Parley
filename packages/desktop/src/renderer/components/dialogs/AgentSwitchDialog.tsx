/**
 * Просьба агента продолжить сессию на другом провайдере (`request_agent_switch`, карточка `agent-switch`): «Allow» —
 * `consents.decide(allow)`, хост выполнит замену; «Deny» — отказ; «Cancel» и Esc закрывают диалог, карточка остаётся
 * (остров, Telegram). Построен на `ConfirmDialog`, как `TrustFolderDialog`: отменой считается только закрытие без выбора.
 */

import { useEffect, useRef } from 'react';
import { S } from '../../../shared/strings.js';
import { ConfirmDialog } from './ConfirmDialog.js';

export interface AgentSwitchDialogProps {
  open: boolean;
  /** Готовая строка просьбы (`switchRequestText`). */
  request: string;
  onAllow: () => void;
  onDeny: () => void;
  /** «Cancel», Esc и закрытие крестиком. */
  onCancel: () => void;
}

export function AgentSwitchDialog({ open, request, onAllow, onDeny, onCancel }: AgentSwitchDialogProps): JSX.Element {
  const text = S.dialogs.agentSwitch;
  // «Allow» и «Deny» тоже заканчиваются `onOpenChange(false)`: без флага за выбором шла бы отмена.
  const chosen = useRef(false);
  useEffect(() => {
    if (open) chosen.current = false;
  }, [open]);

  return (
    <ConfirmDialog
      open={open}
      title={text.title}
      description={request}
      confirmLabel={text.allow}
      confirmVariant="default"
      onConfirm={() => {
        chosen.current = true;
        onAllow();
      }}
      secondary={{
        label: text.deny,
        onSelect: () => {
          chosen.current = true;
          onDeny();
        },
      }}
      onOpenChange={(next) => {
        if (!next && !chosen.current) onCancel();
      }}
    />
  );
}
