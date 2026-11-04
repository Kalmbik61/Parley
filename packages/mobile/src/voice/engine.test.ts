import { beforeEach, describe, expect, it, vi } from 'vitest';

const mod = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  abort: vi.fn(),
  setAudioSessionActiveIOS: vi.fn(),
  supportsOnDeviceRecognition: vi.fn(() => true),
  addListener: vi.fn(() => ({ remove: vi.fn() })),
  getSupportedLocales: vi.fn(async () => ({ locales: ['ru-RU'], installedLocales: [] })),
  currentInputLanguage: vi.fn(async () => 'ru-RU'),
  getPermissionsAsync: vi.fn(async () => ({ granted: false, canAskAgain: true, restricted: true })),
  requestPermissionsAsync: vi.fn(),
}));
vi.mock('expo-speech-recognition', () => ({ ExpoSpeechRecognitionModule: mod }));
vi.mock('../dev/flags', () => ({ DEV_VOICE: null }));

import { createRealEngine } from './engine';

describe('real engine', () => {
  beforeEach(() => vi.clearAllMocks());

  it('start always asks for on-device recognition, continuous, without recordingOptions', () => {
    createRealEngine().start('ru-RU');
    expect(mod.start).toHaveBeenCalledOnce();
    const options = (mod.start.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(options).toMatchObject({ lang: 'ru-RU', requiresOnDeviceRecognition: true, continuous: true, interimResults: false, iosTaskHint: 'dictation' });
    expect(options).not.toHaveProperty('recordingOptions');
  });

  it('checks the language that will be started, not the default', () => {
    createRealEngine().supportsOnDevice('de-DE');
    expect(mod.supportsOnDeviceRecognition).toHaveBeenCalledWith('de-DE');
  });

  it('releases the audio session notifying others', () => {
    createRealEngine().releaseAudioSession();
    expect(mod.setAudioSessionActiveIOS).toHaveBeenCalledWith(false, { notifyOthersOnDeactivation: true });
  });

  it('maps permissions and supported locales', async () => {
    const e = createRealEngine();
    expect(await e.getPermissions()).toEqual({ granted: false, canAskAgain: true, restricted: true });
    expect(await e.supportedLocales()).toEqual(['ru-RU']);
  });

  it('subscribes to the six events and unsubscribes them all', () => {
    const off = createRealEngine().subscribe({ start() {}, result() {}, nomatch() {}, error() {}, end() {}, volume() {} });
    expect((mod.addListener.mock.calls as unknown[][]).map((c) => c[0])).toEqual(['start', 'result', 'nomatch', 'error', 'end', 'volumechange']);
    expect(() => off()).not.toThrow();
  });
});
