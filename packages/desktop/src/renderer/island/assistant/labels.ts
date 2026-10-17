import type { AssistantState } from '@parley/protocol';
import { S } from '../../../shared/strings.js';
import type { InputPhase } from './store.js';

export function statusLabel(host: AssistantState, input: InputPhase): string {
  if (input === 'listening') return S.assistant.listening;
  if (input === 'transcribing') return S.assistant.transcribing;
  switch (host.phase) {
    case 'thinking':
      return S.assistant.thinking;
    case 'tool':
      if (host.detail?.tool === 'overview') return S.assistant.checking;
      if (host.detail?.tool === 'detail') return S.assistant.reading(host.detail.target);
      if (host.detail?.tool === 'propose') return S.assistant.preparing;
      return S.assistant.working;
    case 'answering':
      return S.assistant.answering;
    case 'awaiting-confirm':
      return S.assistant.confirm;
    case 'error':
    case 'offline':
      return host.error ?? S.assistant.working;
    default:
      return S.assistant.ready;
  }
}

export function miniLabel(host: AssistantState, input: InputPhase): string | null {
  if (input !== 'idle') return S.assistant.miniListening;
  switch (host.phase) {
    case 'thinking':
      return S.assistant.miniThinking;
    case 'tool':
    case 'answering':
      return S.assistant.miniWorking;
    case 'awaiting-confirm':
      return S.assistant.miniConfirm;
    default:
      return null;
  }
}

export { hotkeyLabel } from '../../../shared/hotkey.js';
