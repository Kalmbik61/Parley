/** Доступ к микрофону macOS (спека 4.2, 6.3): `systemPreferences` и раздел Privacy → Microphone. */
import type { MicStatus } from '../../shared/voice-types.js';

export const MIC_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone';

/** `getMediaAccessStatus` отдаёт ещё `unknown` (не macOS): для окна это «ещё не спрашивали». */
export function normalizeMicStatus(raw: string): MicStatus {
  return raw === 'granted' || raw === 'denied' || raw === 'restricted' ? raw : 'not-determined';
}
