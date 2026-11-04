import { describe, expect, it } from 'vitest';
import { VOICE_PROMPT, liveSessionConfig } from './voice-prompt.js';

describe('VOICE_PROMPT', () => {
  it('держит шаблон Generate/Do not generate с областями Parley и исключениями', () => {
    expect(VOICE_PROMPT).toContain('Generate <|SpawnThinking|> when:');
    expect(VOICE_PROMPT).toContain('Do not generate <|SpawnThinking|> when:');
    for (const area of ['rooms', 'sessions', 'jobs', 'works', 'builds', 'create or change something in Parley']) expect(VOICE_PROMPT).toContain(area);
    for (const exception of ['greets you or makes small talk', 'still-current result', 'brief clarification']) expect(VOICE_PROMPT).toContain(exception);
  });

  it('просит короткое подтверждение, пересказ со временем снимка, молчание об id и карточку на экране', () => {
    expect(VOICE_PROMPT).toContain('one very short spoken acknowledgment');
    expect(VOICE_PROMPT).toContain('tie it to the question');
    expect(VOICE_PROMPT).toContain('how old the snapshot is');
    expect(VOICE_PROMPT).toContain('Never speak identifiers');
    expect(VOICE_PROMPT).toContain('prepared a card');
    expect(VOICE_PROMPT).toContain('confirm it on the screen');
  });

  it('конфиг сессии: модель, инструкции, клиентская делегация без задержки подтверждения', () => {
    expect(liveSessionConfig()).toEqual({ model: 'gpt-live-1', instructions: VOICE_PROMPT, delegation: { type: 'client' } });
  });
});
