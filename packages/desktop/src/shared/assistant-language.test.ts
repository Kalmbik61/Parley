import { describe, expect, it } from 'vitest';
import { systemAssistantLanguage } from './assistant-language.js';

describe('systemAssistantLanguage', () => {
  it('первый подтег локали, если его знает Whisper', () => {
    expect(systemAssistantLanguage('ru-RU')).toBe('ru');
    expect(systemAssistantLanguage('en-US')).toBe('en');
    expect(systemAssistantLanguage('uk')).toBe('uk');
    expect(systemAssistantLanguage('zh-Hans-CN')).toBe('zh');
    expect(systemAssistantLanguage('DE_de')).toBe('de');
  });
  it('незнакомая или пустая локаль и auto — en', () => {
    expect(systemAssistantLanguage('xx-YY')).toBe('en');
    expect(systemAssistantLanguage('')).toBe('en');
    expect(systemAssistantLanguage('auto')).toBe('en');
  });
});
