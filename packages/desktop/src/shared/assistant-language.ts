import { isVoiceLanguage } from './voice-types.js';

/** Язык помощника по локали системы: первый подтег, если его знает Whisper, иначе `en`. */
export function systemAssistantLanguage(locale: string): string {
  const primary = locale.split(/[-_]/)[0]?.toLowerCase() ?? '';
  return primary !== 'auto' && isVoiceLanguage(primary) ? primary : 'en';
}
