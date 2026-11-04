/** Единственное место, где импортируется `expo-speech-recognition` (спека 4.1). Тонкая обёртка над Apple Speech. */
import { ExpoSpeechRecognitionModule } from 'expo-speech-recognition';
import { DEV_VOICE } from '../dev/flags';
import type { Engine, EngineEvents, Permission } from './dictation';
import type { LanguageSource } from './language';
import { createFakeEngine } from './fake-engine';

export interface VoiceEngine extends Engine, LanguageSource {
  getPermissions(): Promise<Permission>;
  requestPermissions(): Promise<Permission>;
}

const toPermission = (r: { granted: boolean; canAskAgain: boolean; restricted?: boolean }): Permission => ({
  granted: r.granted,
  canAskAgain: r.canAskAgain,
  restricted: r.restricted === true,
});

export function createRealEngine(): VoiceEngine {
  const module = ExpoSpeechRecognitionModule;
  return {
    start(lang) {
      // Звук не уходит с телефона: распознавание только на устройстве (спека 2.2). Файл не пишется (`recordingOptions` нет).
      module.start({
        lang,
        requiresOnDeviceRecognition: true,
        continuous: true,
        interimResults: false,
        addsPunctuation: true,
        iosTaskHint: 'dictation',
        volumeChangeEventOptions: { enabled: true, intervalMillis: 100 },
      });
    },
    stop: () => module.stop(),
    abort: () => module.abort(),
    releaseAudioSession() {
      module.setAudioSessionActiveIOS(false, { notifyOthersOnDeactivation: true });
    },
    subscribe(events: EngineEvents) {
      const subs = [
        module.addListener('start', () => events.start()),
        module.addListener('result', (e) => events.result({ isFinal: e.isFinal, results: e.results.map((r) => ({ transcript: r.transcript })) })),
        module.addListener('nomatch', () => events.nomatch()),
        module.addListener('error', (e) => events.error(e.error, e.message)),
        module.addListener('end', () => events.end()),
        module.addListener('volumechange', (e) => events.volume(e.value)),
      ];
      return () => subs.forEach((s) => s.remove());
    },
    supportsOnDevice: (lang) => module.supportsOnDeviceRecognition(lang),
    supportedLocales: async () => (await module.getSupportedLocales({})).locales,
    // Вариант (а) спеки 2.3: язык клавиатуры. Вариант (б) удаляет этот метод вместе с правкой 4 заплатки.
    inputLanguage: async () => module.currentInputLanguage().catch(() => null),
    getPermissions: async () => toPermission(await module.getPermissionsAsync()),
    requestPermissions: async () => toPermission(await module.requestPermissionsAsync()),
  };
}

export const engine: VoiceEngine = DEV_VOICE !== null ? createFakeEngine(DEV_VOICE === 'fake-off' ? 'off' : 'on') : createRealEngine();
