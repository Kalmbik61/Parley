import { describe, expect, it } from 'vitest';
import { downsampleTo16k, pcm16ToWav } from './wav.js';

describe('pcm16ToWav', () => {
  it('пишет 44-байтный заголовок: RIFF/WAVE, 16 кГц, моно, 16 бит', () => {
    const wav = pcm16ToWav(new Int16Array([1, -2, 3]));
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt32LE(28)).toBe(32_000);
    expect(wav.readUInt16LE(34)).toBe(16);
  });

  it('длина данных и размер файла сходятся', () => {
    const wav = pcm16ToWav(new Int16Array([1, -2, 3]));
    expect(wav.readUInt32LE(40)).toBe(6);
    expect(wav.readUInt32LE(4)).toBe(36 + 6);
    expect(wav.length).toBe(44 + 6);
    expect(wav.readInt16LE(46)).toBe(-2);
  });
});

describe('downsampleTo16k', () => {
  it('48 кГц даёт втрое меньше отсчётов и усредняет тройки', () => {
    const out = downsampleTo16k(new Float32Array([0.3, 0.3, 0.3, -0.6, -0.6, -0.6]), 48_000);
    expect(out.length).toBe(2);
    expect(out[0]).toBe(Math.round(0.3 * 0x7fff));
    expect(out[1]).toBe(Math.round(-0.6 * 0x8000));
  });

  it('обрезает значения за пределами [-1, 1]', () => {
    const out = downsampleTo16k(new Float32Array([2, 2, 2, -2, -2, -2]), 48_000);
    expect(Array.from(out)).toEqual([0x7fff, -0x8000]);
  });
});
