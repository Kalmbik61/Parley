import { describe, expect, it, vi } from 'vitest';
import { createFakeVoiceServices } from './services.js';

describe('createFakeVoiceServices (E2E, PARLEY_VOICE=fake)', () => {
  it('моделей нет, «скачивание» сразу с прогрессом, после — в списке; remove убирает', async () => {
    const voice = createFakeVoiceServices('hello from voice');
    await expect(voice.listModels()).resolves.toEqual([]);
    const progress = vi.fn();
    await expect(voice.download('base', progress)).resolves.toEqual({ ok: true });
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ id: 'base' }));
    await expect(voice.listModels()).resolves.toEqual(['base']);
    await voice.remove('base');
    await expect(voice.listModels()).resolves.toEqual([]);
  });

  it('микрофон есть, распознавание отдаёт заданный текст', async () => {
    const voice = createFakeVoiceServices('hello from voice');
    expect(voice.micStatus()).toBe('granted');
    await expect(voice.requestMic()).resolves.toBe(true);
    await expect(voice.transcribe({ pcm: new ArrayBuffer(2), language: 'auto', model: 'base' })).resolves.toEqual({ text: 'hello from voice' });
  });
});
