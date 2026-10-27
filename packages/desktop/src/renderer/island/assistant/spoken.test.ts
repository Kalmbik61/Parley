/** Шаблонные фразы речи помощника (план 3, Task 6; #9 §6.8, T14): «Sent» по языку и роду голоса. */

import { describe, expect, it } from 'vitest';

import { spokenPhrase } from './spoken.js';

describe('spokenPhrase', () => {
  it('G2: по-русски фраза в роде голоса', () => {
    expect(spokenPhrase('sent', 'ru', 'female')).toBe('Отправила.');
    expect(spokenPhrase('sent', 'ru', 'male')).toBe('Отправил.');
    expect(spokenPhrase('sent', 'ru', 'neutral')).toBe('Отправлено.');
  });

  it('G2: по-английски одна форма на все роды', () => {
    expect(spokenPhrase('sent', 'en', 'female')).toBe('Sent.');
    expect(spokenPhrase('sent', 'en', 'male')).toBe('Sent.');
    expect(spokenPhrase('sent', 'en', 'neutral')).toBe('Sent.');
  });

  it('прочие языки помощника говорят по-английски', () => {
    expect(spokenPhrase('sent', 'uk', 'female')).toBe('Sent.');
    expect(spokenPhrase('sent', 'de', 'male')).toBe('Sent.');
  });
});
