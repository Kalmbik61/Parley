import { describe, expect, it } from 'vitest';
import { floatTo16, joinChunks } from './pcm.js';

describe('PCM Int16', () => {
  it('float -1…1 → Int16 с насыщением', () => {
    expect([...floatTo16(new Float32Array([0, 1, -1, 2, -2, 0.5]))]).toEqual([0, 32767, -32768, 32767, -32768, 16383]);
  });

  it('куски склеиваются по порядку', () => {
    expect([...joinChunks([new Int16Array([1, 2]), new Int16Array([]), new Int16Array([3])])]).toEqual([1, 2, 3]);
  });
});
