import { describe, expect, it } from 'vitest';
import { cleanTranscript } from './result-filter.js';

describe('cleanTranscript (спека 6.1)', () => {
  it('строки сегментов склеиваются через пробел, края обрезаются', () => {
    expect(cleanTranscript('  Refactor the middleware.\n Use the new helper.\n')).toBe('Refactor the middleware. Use the new helper.');
  });

  it('пусто и пробелы — речи нет', () => {
    expect(cleanTranscript('')).toBeNull();
    expect(cleanTranscript(' \n \n')).toBeNull();
  });

  it('только служебные метки в скобках — речи нет', () => {
    expect(cleanTranscript('[BLANK_AUDIO]')).toBeNull();
    expect(cleanTranscript(' (музыка) \n[Музыка]')).toBeNull();
  });

  it('известная галлюцинация целиком — речи нет, без учёта регистра и точек', () => {
    expect(cleanTranscript('Продолжение следует...')).toBeNull();
    expect(cleanTranscript('Субтитры сделал DimaTorzok')).toBeNull();
    expect(cleanTranscript('Thank you for watching!')).toBeNull();
  });

  it('фраза, где те же слова — часть текста, проходит', () => {
    expect(cleanTranscript('Продолжение следует после ревью API')).toBe('Продолжение следует после ревью API');
    expect(cleanTranscript('Say thank you for watching to the user')).toBe('Say thank you for watching to the user');
  });

  it('метка рядом с речью остаётся частью текста', () => {
    expect(cleanTranscript('Fix the build [BLANK_AUDIO]')).toBe('Fix the build [BLANK_AUDIO]');
  });

  it('длинная цепочка меток: с текстом в конце проходит, без текста — речи нет, быстро', () => {
    const chain = '[a] '.repeat(5000);
    const start = Date.now();
    expect(cleanTranscript(`${chain}x`)).toBe(`${chain}x`);
    expect(cleanTranscript(chain)).toBeNull();
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
