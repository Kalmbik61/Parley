import { describe, expect, expectTypeOf, it } from 'vitest';
import type { AssistantOrigin } from './assistant.js';
import { METHODS } from './methods.js';

describe('схемы методов Telegram', () => {
  it('telegram.setToken принимает токен и отвергает пустые параметры', () => {
    expect(METHODS['telegram.setToken'].safeParse({ token: '123456:AAAA' }).success).toBe(true);
    expect(METHODS['telegram.setToken'].safeParse({}).success).toBe(false);
  });
  it('telegram.status принимает пустые параметры', () => {
    expect(METHODS['telegram.status'].safeParse({}).success).toBe(true);
  });
  it('METHODS содержит все шесть методов telegram', () => {
    for (const name of ['setToken', 'clearToken', 'link', 'unlink', 'takeOver', 'status']) {
      expect(Object.keys(METHODS)).toContain(`telegram.${name}`);
    }
  });
});

describe('assistant.configure', () => {
  const ok = { enabled: true, provider: 'claude', model: null, language: 'en', voiceModel: '/m/ggml-base.bin' };
  it('принимает настройки и отвергает длинный код языка', () => {
    expect(METHODS['assistant.configure'].safeParse(ok).success).toBe(true);
    expect(METHODS['assistant.configure'].safeParse({ ...ok, language: 'english' }).success).toBe(false);
  });
  it('AssistantOrigin включает telegram', () => {
    expectTypeOf<AssistantOrigin>().toEqualTypeOf<'island' | 'reminder' | 'telegram'>();
  });
});
