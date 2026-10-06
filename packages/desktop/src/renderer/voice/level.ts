/** Громкость записи (спека 3.2, 6.1): полоска у кнопки и порог тишины до вызова движка. */

/** Пик ниже этого — тишина: движок не зовётся (≈ −34 dBFS). Подбирается на живой проверке (задача 14 плана). */
export const SILENCE_PEAK = 0.02;

export function rms(frame: Float32Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (const sample of frame) sum += sample * sample;
  return Math.sqrt(sum / frame.length);
}

export function peakOf(frame: Float32Array): number {
  let peak = 0;
  for (const sample of frame) peak = Math.max(peak, Math.abs(sample));
  return peak;
}

export function isSilent(peak: number): boolean {
  return peak < SILENCE_PEAK;
}

/** Речь у микрофона — rms 0.02…0.2: ×8 делает тихую речь заметной, а громкую упирает в край. */
export function levelWidth(level: number): number {
  return Math.min(1, Math.max(0, level * 8));
}
