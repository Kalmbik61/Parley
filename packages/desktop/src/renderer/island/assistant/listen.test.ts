import { describe, expect, it, vi } from 'vitest';
import { listen, silenceGate, SILENCE_MS, NO_SPEECH_MS, type ListenDeps } from './listen.js';

describe('silenceGate', () => {
  it('стоп после SILENCE_MS тишины, когда речь уже была', () => {
    let t = 0;
    const gate = silenceGate(() => t);
    expect(gate(0.3)).toBe(false);
    t = 500;
    expect(gate(0.001)).toBe(false);
    t = 500 + SILENCE_MS;
    expect(gate(0.001)).toBe(true);
  });
  it('без речи — стоп через NO_SPEECH_MS', () => {
    let t = 0;
    const gate = silenceGate(() => t);
    t = NO_SPEECH_MS - 1;
    expect(gate(0)).toBe(false);
    t = NO_SPEECH_MS;
    expect(gate(0)).toBe(true);
  });
});

function deps(over: Partial<ListenDeps> = {}): ListenDeps {
  const recording = { stop: vi.fn().mockResolvedValue({ pcm: new ArrayBuffer(4), durationMs: 900, peak: 0.4 }), cancel: vi.fn() };
  return {
    record: vi.fn().mockResolvedValue(recording),
    transcribe: vi.fn().mockResolvedValue({ text: ' Кто работает? ' }),
    micStatus: vi.fn().mockResolvedValue('granted'),
    requestMic: vi.fn().mockResolvedValue(true),
    now: () => 0,
    model: 'small',
    language: 'ru',
    onLevel: vi.fn(),
    onTranscribing: vi.fn(),
    ...over,
  } as ListenDeps;
}

describe('listen', () => {
  it('стоп → распознавание → текст', async () => {
    const session = listen(deps());
    await Promise.resolve();
    session.stop();
    await expect(session.result).resolves.toEqual({ text: 'Кто работает?' });
  });
  it('нет доступа к микрофону — mic', async () => {
    const session = listen(deps({ micStatus: vi.fn().mockResolvedValue('denied') }));
    await expect(session.result).resolves.toEqual({ error: 'mic' });
  });
  it('отмена — cancelled, без распознавания', async () => {
    const d = deps();
    const session = listen(d);
    session.cancel();
    await expect(session.result).resolves.toEqual({ error: 'cancelled' });
    expect(d.transcribe).not.toHaveBeenCalled();
  });
  it('пустой текст — no_speech', async () => {
    const session = listen(deps({ transcribe: vi.fn().mockResolvedValue({ text: '  ' }) }));
    session.stop();
    await expect(session.result).resolves.toEqual({ error: 'no_speech' });
  });
  it('тихая речь (RMS ниже 0.02, пик выше) — речь: стоп через SILENCE_MS после неё, а не через NO_SPEECH_MS', async () => {
    let t = 0;
    const recording = { stop: vi.fn().mockResolvedValue({ pcm: new ArrayBuffer(4), durationMs: 900, peak: 0.06 }), cancel: vi.fn() };
    const d = deps({ now: () => t, record: vi.fn().mockResolvedValue(recording) });
    const session = listen(d);
    await vi.waitFor(() => expect(d.record).toHaveBeenCalled());
    const feed = vi.mocked(d.record).mock.calls[0]?.[0];
    if (!feed) throw new Error('record не получил колбэк громкости');
    feed(0.015, 0.06);
    t = 500;
    feed(0.001, 0.004);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(recording.stop).not.toHaveBeenCalled();
    // Время далеко от NO_SPEECH_MS: по старому порогу RMS речь не была бы замечена и остров ждал бы все 8 с.
    t = 500 + SILENCE_MS;
    feed(0.001, 0.004);
    await expect(session.result).resolves.toEqual({ text: 'Кто работает?' });
    expect(recording.stop).toHaveBeenCalledTimes(1);
    // Наружу, в полоску громкости, уходит именно RMS, а не пик.
    expect(d.onLevel).toHaveBeenNthCalledWith(1, 0.015);
    expect(d.onLevel).toHaveBeenNthCalledWith(2, 0.001);
  });
});
