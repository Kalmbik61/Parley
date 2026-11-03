import { describe, expect, it } from 'vitest';
import { createFakeTtsService, type TtsChunk, type TtsService } from './tts.js';

const REQUEST = { utteranceId: 'u-1', text: 'Hello.', voice: 'default', language: 'en' };

describe('createFakeTtsService (PARLEY_TTS=fake)', () => {
  it('speak отдаёт два куска тишины, второй final, и состояние ready', async () => {
    const tts: TtsService = createFakeTtsService();
    const chunks: TtsChunk[] = [];
    await expect(tts.speak(REQUEST, (chunk) => chunks.push(chunk))).resolves.toEqual({ state: 'ready' });
    expect(chunks.map((chunk) => [chunk.seq, chunk.final])).toEqual([[0, false], [1, true]]);
    expect(chunks[0]!.pcm.length).toBeGreaterThan(0);
  });
});
