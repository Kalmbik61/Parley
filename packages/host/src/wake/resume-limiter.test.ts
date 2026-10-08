import { describe, expect, it } from 'vitest';
import type { SessionRef } from '@parley/protocol';
import { ResumeLimiter } from './resume-limiter.js';

const ref = (sessionId: string): SessionRef => ({ projectPath: '/tmp/p', workId: 'w-01', sessionId });

describe('ResumeLimiter', () => {
  it('2: шесть подряд — да, седьмой — нет, через час снова да; у каждой сессии свой счёт', () => {
    let now = 1_000_000;
    const limiter = new ResumeLimiter(() => 6, () => now);
    const a = ref('s-01');

    for (let i = 0; i < 6; i += 1) {
      expect(limiter.tryTake(a)).toBe(true);
      now += 60_000;
    }
    expect(limiter.tryTake(a)).toBe(false);
    // Чужой лимит не тронут.
    expect(limiter.tryTake(ref('s-02'))).toBe(true);

    // Первый подъём был ровно час назад плюс минута на каждый следующий:
    // через час от первого освобождается одно место, а не все шесть.
    now = 1_000_000 + 60 * 60 * 1000;
    expect(limiter.tryTake(a)).toBe(true);
    expect(limiter.tryTake(a)).toBe(false);

    // Час от последнего — лимит снова целый.
    now += 60 * 60 * 1000;
    for (let i = 0; i < 6; i += 1) expect(limiter.tryTake(a)).toBe(true);
    expect(limiter.tryTake(a)).toBe(false);
  });

  it('release возвращает последний взятый подъём этой сессии, чужие и прежние не трогает (P37)', () => {
    let now = 1_000_000;
    const limiter = new ResumeLimiter(() => 2, () => now);
    const a = ref('s-01');
    expect(limiter.tryTake(a)).toBe(true);
    now += 1000;
    expect(limiter.tryTake(a)).toBe(true);
    expect(limiter.tryTake(ref('s-02'))).toBe(true);
    expect(limiter.tryTake(a)).toBe(false);

    // Подъём не состоялся (бюджет работы отказал): вернулся один слот, а не все.
    limiter.release(a);
    expect(limiter.tryTake(a)).toBe(true);
    expect(limiter.tryTake(a)).toBe(false);
    expect(limiter.tryTake(ref('s-02'))).toBe(true);
    limiter.release(ref('s-99')); // неизвестная сессия — ничего не ломает
  });

  it('rate 0 — не поднимается никогда', () => {
    const limiter = new ResumeLimiter(() => 0);
    expect(limiter.tryTake(ref('s-01'))).toBe(false);
  });
});
