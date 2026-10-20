/** WAV для `whisper-cli` (план B, задача 9): PCM Int16 little-endian, моно, 44-байтный заголовок — как у окна. */

export const SAMPLE_RATE = 16_000;

export function pcm16ToWav(pcm: Int16Array, sampleRate: number = SAMPLE_RATE): Buffer {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** Моно Float32 → 16 кГц Int16: среднее по окну `ratio` отсчётов, значения за пределами [-1, 1] обрезаются. */
export function downsampleTo16k(channel: Float32Array, sampleRate: number): Int16Array {
  const ratio = sampleRate / SAMPLE_RATE;
  const length = Math.floor(channel.length / ratio);
  const out = new Int16Array(length);
  for (let i = 0; i < length; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(channel.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += channel[j] ?? 0;
    const mean = Math.max(-1, Math.min(1, sum / (end - start)));
    out[i] = Math.round(mean < 0 ? mean * 0x8000 : mean * 0x7fff);
  }
  return out;
}
