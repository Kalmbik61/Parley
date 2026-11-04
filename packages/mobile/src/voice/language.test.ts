import { describe, expect, it } from 'vitest';
import { reasonNoLanguage, reasonOnDevice } from './dictation';
import { createLanguageChooser } from './language';

const SUPPORTED = ['en-US', 'ru-RU', 'de-DE'];
function chooser(over: { onDevice?: string[]; keyboard?: string | null; device?: string; supported?: string[] } = {}) {
  const onDevice = over.onDevice ?? SUPPORTED;
  const state = { keyboard: over.keyboard ?? null };
  const choose = createLanguageChooser(
    {
      supportsOnDevice: (l) => onDevice.includes(l),
      supportedLocales: async () => over.supported ?? SUPPORTED,
      inputLanguage: async () => state.keyboard,
    },
    () => over.device ?? 'ru-RU',
  );
  return { choose, state };
}

describe('language chooser', () => {
  it('the device language when the keyboard says nothing', async () => {
    expect(await chooser().choose({ useKeyboard: true, focused: true })).toEqual({ ok: true, lang: 'ru-RU' });
  });
  it('the keyboard language first when the field is focused', async () => {
    expect(await chooser({ keyboard: 'en-US' }).choose({ useKeyboard: true, focused: true })).toEqual({ ok: true, lang: 'en-US' });
  });
  it('emoji and dictation are skipped', async () => {
    expect(await chooser({ keyboard: 'emoji' }).choose({ useKeyboard: true, focused: true })).toEqual({ ok: true, lang: 'ru-RU' });
  });
  it('an unfocused field uses the last keyboard language of this launch', async () => {
    const { choose } = chooser({ keyboard: 'de-DE' });
    await choose({ useKeyboard: true, focused: true });
    expect(await choose({ useKeyboard: true, focused: false })).toEqual({ ok: true, lang: 'de-DE' });
  });
  it('device-only mode ignores the keyboard', async () => {
    const { choose } = chooser({ keyboard: 'en-US' });
    await choose({ useKeyboard: true, focused: true });
    expect(await choose({ useKeyboard: false, focused: false })).toEqual({ ok: true, lang: 'ru-RU' });
  });
  it('falls back from a keyboard language without on-device recognition to the device language', async () => {
    const result = await chooser({ keyboard: 'de-DE', onDevice: ['ru-RU'] }).choose({ useKeyboard: true, focused: true });
    expect(result).toEqual({ ok: true, lang: 'ru-RU' });
  });
  it('candidates without on-device recognition → reason 1 with the first candidate', async () => {
    expect(await chooser({ onDevice: [] }).choose({ useKeyboard: true, focused: false })).toEqual({ ok: false, lang: 'ru-RU', reason: reasonOnDevice('ru-RU') });
  });
  it('no candidates → reason 2 with the language tag', async () => {
    expect(await chooser({ supported: [], device: 'xx-YY' }).choose({ useKeyboard: true, focused: false })).toEqual({ ok: false, lang: 'xx-YY', reason: reasonNoLanguage('xx-YY') });
  });
});
