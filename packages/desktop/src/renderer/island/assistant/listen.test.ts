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
});
