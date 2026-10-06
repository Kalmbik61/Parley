import { describe, expect, it, vi } from 'vitest';
import { MicError, startRecording, type CaptureContext, type CaptureNode, type RecorderDeps } from './recorder.js';

function fakeDeps(overrides: Partial<RecorderDeps> = {}) {
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const node: CaptureNode = { port: { onmessage: null }, connect: vi.fn(), disconnect: vi.fn() };
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const context: CaptureContext = {
    audioWorklet: { addModule: vi.fn(async () => undefined) },
    createMediaStreamSource: vi.fn(() => source),
    destination: {},
    close: vi.fn(async () => undefined),
  };
  const deps: RecorderDeps = {
    getUserMedia: vi.fn(async () => stream),
    createContext: () => context,
    createNode: () => node,
    workletUrl: async () => 'worklet.js',
    ...overrides,
  };
  const frame = (samples: number[]) => node.port.onmessage?.({ data: new Float32Array(samples) } as MessageEvent<Float32Array>);
  return { deps, track, context, node, frame };
}

describe('startRecording', () => {
  it('кадры копятся в PCM Int16, громкость — наружу; stop закрывает микрофон и контекст', async () => {
    const { deps, track, context, frame } = fakeDeps();
    const levels: number[] = [];
    const recording = await startRecording((level) => levels.push(level), deps);
    frame([0.5, -0.5]);
    frame([0.25]);
    const audio = await recording.stop();
    expect([...new Int16Array(audio.pcm)]).toEqual([16383, -16384, 8191]);
    expect(audio.peak).toBeCloseTo(0.5);
    expect(audio.durationMs).toBeCloseTo((3 / 16_000) * 1000);
    expect(levels).toHaveLength(2);
    expect(track.stop).toHaveBeenCalled();
    expect(context.close).toHaveBeenCalled();
  });

  it('cancel закрывает всё и ничего не отдаёт', async () => {
    const { deps, track } = fakeDeps();
    const recording = await startRecording(() => undefined, deps);
    recording.cancel();
    await vi.waitFor(() => expect(track.stop).toHaveBeenCalled());
  });

  it('NotAllowedError — MicError denied, NotFoundError — not_found', async () => {
    const denied = fakeDeps({ getUserMedia: async () => Promise.reject(new DOMException('no', 'NotAllowedError')) });
    await expect(startRecording(() => undefined, denied.deps)).rejects.toMatchObject({ kind: 'denied' });
    const missing = fakeDeps({ getUserMedia: async () => Promise.reject(new DOMException('no', 'NotFoundError')) });
    await expect(startRecording(() => undefined, missing.deps)).rejects.toBeInstanceOf(MicError);
  });
});
