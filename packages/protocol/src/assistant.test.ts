import { describe, expect, it } from 'vitest';
import { METHODS } from './methods.js';

describe('схемы методов помощника', () => {
  it('assistant.ask: текст обязателен, провайдер и модель могут быть null', () => {
    expect(METHODS['assistant.ask'].safeParse({ text: 'кто работает?', provider: null, model: null, language: 'ru' }).success).toBe(true);
    expect(METHODS['assistant.ask'].safeParse({ text: '', provider: null, model: null, language: 'ru' }).success).toBe(false);
    expect(METHODS['assistant.ask'].safeParse({ text: 'x', provider: 'claude', model: 'haiku', language: 'RU' }).success).toBe(false);
  });
  it('assistant.ask: язык — код Whisper из двух-трёх латинских строчных букв', () => {
    const ask = (language: string): boolean => METHODS['assistant.ask'].safeParse({ text: 'x', provider: null, model: null, language }).success;
    expect(ask('uk')).toBe(true);
    expect(ask('yue')).toBe(true);
    expect(ask('english')).toBe(false);
    expect(ask('RU')).toBe(false);
  });
  it('assistant.decide: только send и cancel', () => {
    expect(METHODS['assistant.decide'].safeParse({ proposalId: 'p1', decision: 'send' }).success).toBe(true);
    expect(METHODS['assistant.decide'].safeParse({ proposalId: 'p1', decision: 'maybe' }).success).toBe(false);
  });
  it('assistant.sent: ссылка на сессию', () => {
    expect(METHODS['assistant.sent'].safeParse({ ref: { projectPath: '/p', workId: 'w', sessionId: 's' } }).success).toBe(true);
  });
});
