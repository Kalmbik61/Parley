import type { AssistantState } from '@parley/protocol';
import { S } from '../../../shared/strings.js';
import type { InputPhase } from './store.js';

/** `sending` — вопрос ушёл, а хост ещё не начал по нему ход (`Sending…`). */
export function statusLabel(host: AssistantState, input: InputPhase, sending = false): string {
  if (input === 'listening') return S.assistant.listening;
  if (input === 'transcribing') return S.assistant.transcribing;
  if (input === 'speaking') return S.assistant.speaking;
  if (input === 'settling') return S.assistant.spoken;
  if (sending) return S.assistant.sending;
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

export function miniLabel(host: AssistantState, input: InputPhase, sending = false): string | null {
  if (input === 'speaking') return S.assistant.miniSpeaking;
  if (input === 'settling') return S.assistant.miniSpoken;
  if (input !== 'idle') return S.assistant.miniListening;
  if (sending) return S.assistant.miniSending;
  switch (host.phase) {
    case 'thinking':
      return S.assistant.miniThinking;
    case 'tool':
    case 'answering':
      return S.assistant.miniWorking;
    case 'awaiting-confirm':
      // Не письмо (комната, решение): «Confirm send» было бы неправдой.
      return (host.proposal?.action ?? 'message') === 'message' ? S.assistant.miniConfirm : S.assistant.miniCard;
    default:
      return null;
  }
}

export { hotkeyLabel } from '../../../shared/hotkey.js';
