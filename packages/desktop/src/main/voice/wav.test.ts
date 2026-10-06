import { describe, expect, it } from 'vitest';
import { pcm16ToWav } from './wav.js';

describe('pcm16ToWav', () => {
  it('заголовок RIFF/WAVE PCM 16 бит моно 16 кГц, данные следом', () => {
    const pcm = Buffer.from([1, 0, 2, 0, 3, 0]);
    const wav = pcm16ToWav(pcm);
    expect(wav.length).toBe(44 + 6);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(4)).toBe(36 + 6);
    expect(wav.toString('ascii', 8, 16)).toBe('WAVEfmt ');
    expect(wav.readUInt32LE(16)).toBe(16); // размер fmt
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // моно
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt32LE(28)).toBe(32_000); // байт в секунду
    expect(wav.readUInt16LE(32)).toBe(2); // выравнивание блока
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.toString('ascii', 36, 40)).toBe('data');
    expect(wav.readUInt32LE(40)).toBe(6);
    expect([...wav.subarray(44)]).toEqual([1, 0, 2, 0, 3, 0]);
  });
});
