/** Float32 AudioWorklet → PCM Int16 little-endian, который ждёт `main/voice/wav.ts`. */

export function floatTo16(frame: Float32Array): Int16Array {
  const out = new Int16Array(frame.length);
  for (let i = 0; i < frame.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, frame[i] ?? 0));
    out[i] = sample < 0 ? Math.round(sample * 0x8000) : Math.floor(sample * 0x7fff);
  }
  return out;
}

export function joinChunks(chunks: readonly Int16Array[]): Int16Array {
  const out = new Int16Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
