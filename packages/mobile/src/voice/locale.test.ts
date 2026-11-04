import { describe, expect, it } from 'vitest';
import { isLanguageTag, localeCandidates } from './locale';

const SUPPORTED = ['en-US', 'en-GB', 'en-AE', 'ru-RU', 'de-DE', 'es-ES', 'es-MX', 'pt-BR', 'zh-CN', 'zh-TW', 'zh-HK', 'fr-FR'];

describe('localeCandidates (spec 2.3)', () => {
  it('exact match, with _ as -', () => {
    expect(localeCandidates('ru-RU', SUPPORTED)[0]).toBe('ru-RU');
    expect(localeCandidates('de_DE', SUPPORTED)[0]).toBe('de-DE');
    expect(localeCandidates('es-MX', SUPPORTED)[0]).toBe('es-MX');
  });
  it('language-LANGUAGE for a foreign region', () => {
    expect(localeCandidates('ru-US', SUPPORTED)[0]).toBe('ru-RU');
    expect(localeCandidates('de-RU', SUPPORTED)[0]).toBe('de-DE');
    expect(localeCandidates('fr', SUPPORTED)[0]).toBe('fr-FR');
  });
  it('en-GB stays en-GB, en-RU goes to en-US before en-AE', () => {
    expect(localeCandidates('en-GB', SUPPORTED)[0]).toBe('en-GB');
    const list = localeCandidates('en-RU', SUPPORTED);
    expect(list[0]).toBe('en-US');
    expect(list.indexOf('en-AE')).toBeGreaterThan(0);
  });
  it('without en-US the other variants of the language are used', () => {
    expect(localeCandidates('en-RU', ['en-GB', 'ru-RU'])[0]).toBe('en-GB');
    expect(localeCandidates('en', ['en-AE', 'en-GB'])).toEqual(['en-AE', 'en-GB'].sort());
  });
  it('preferences: es, pt', () => {
    expect(localeCandidates('es-US', SUPPORTED)[0]).toBe('es-ES');
    expect(localeCandidates('pt-PT', SUPPORTED)[0]).toBe('pt-BR');
  });
  it('zh: script and region pick the variant, no other zh variants', () => {
    expect(localeCandidates('zh-Hans-CN', SUPPORTED)[0]).toBe('zh-CN');
    expect(localeCandidates('zh-Hant-US', SUPPORTED)[0]).toBe('zh-TW');
    expect(localeCandidates('zh-Hant-HK', SUPPORTED)[0]).toBe('zh-HK');
    expect(localeCandidates('zh-Hans-US', SUPPORTED)).toEqual(['zh-CN']);
  });
  it('nothing for an unknown language, an empty list or a mode name', () => {
    expect(localeCandidates('xx-YY', SUPPORTED)).toEqual([]);
    expect(localeCandidates('ru-RU', [])).toEqual([]);
    expect(localeCandidates('emoji', SUPPORTED)).toEqual([]);
  });
  it('no duplicates', () => {
    const list = localeCandidates('en-US', SUPPORTED);
    expect(new Set(list).size).toBe(list.length);
  });
});

describe('isLanguageTag', () => {
  it('accepts tags, rejects keyboard mode names', () => {
    for (const ok of ['ru', 'ru-RU', 'en_US', 'zh-Hans-CN']) expect(isLanguageTag(ok)).toBe(true);
    for (const bad of ['emoji', 'dictation', '', null, undefined, 42]) expect(isLanguageTag(bad)).toBe(false);
  });
});
