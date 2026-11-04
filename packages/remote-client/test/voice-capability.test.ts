import { describe, expect, it } from 'vitest';
import { selectVoiceCapability } from '../src/index.js';

describe('голос из hello моста', () => {
  it('prepare в hello.methods — голос доступен; нет (remoteVoice выключен) или нет hello — нельзя', () => {
    expect(selectVoiceCapability({ methods: ['jobs.submit', 'voice.session.prepare'] })).toEqual({ canUseVoice: true });
    expect(selectVoiceCapability({ methods: ['jobs.submit', 'voice.usage.get'] })).toEqual({ canUseVoice: false });
    expect(selectVoiceCapability({ methods: null })).toEqual({ canUseVoice: false });
  });
});
