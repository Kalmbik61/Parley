/**
 * Политика WebGL (кусок 5.3, спека 8.1): видимые и шесть последних скрытых; решение
 * приходит и давно скрытому терминалу. Тест 9 брифа.
 */

import { describe, expect, it } from 'vitest';
import { createWebglPolicy } from './webgl-policy.js';

describe('тест 9: createWebglPolicy', () => {
  function eight() {
    const policy = createWebglPolicy();
    const keys = Array.from({ length: 8 }, (_, i) => `t${i + 1}`);
    const seen = new Map<string, boolean[]>();
    for (const key of keys) {
      policy.update(key, true);
      seen.set(key, []);
      policy.subscribe(key, (want) => seen.get(key)?.push(want));
    }
    return { policy, keys, seen, last: (key: string) => seen.get(key)?.at(-1) };
  }

  it('восемь видимых скрываются по очереди: два старейших получают false без своего update, шесть последних — true', () => {
    const { policy, keys, seen, last } = eight();
    for (const key of keys) expect(seen.get(key)).toEqual([true]);

    for (const key of keys.slice(0, 6)) policy.update(key, false);
    for (const key of keys) expect(last(key)).toBe(true);

    policy.update('t7', false);
    expect(last('t1')).toBe(false);
    expect(last('t2')).toBe(true);
    policy.update('t8', false);
    expect(last('t2')).toBe(false);
    for (const key of keys.slice(2)) expect(last(key)).toBe(true);
    // Решения шлются только на перемену.
    expect(seen.get('t3')).toEqual([true]);
  });

  it('forget одного из шести — место получает следующий скрытый', () => {
    const { policy, keys, last } = eight();
    for (const key of keys) policy.update(key, false);
    expect(last('t2')).toBe(false);
    policy.forget('t5');
    expect(last('t2')).toBe(true);
    expect(last('t1')).toBe(false);
  });

  it('снова видимый — true, даже если был вытеснен', () => {
    const { policy, keys, last } = eight();
    for (const key of keys) policy.update(key, false);
    policy.update('t1', true);
    expect(last('t1')).toBe(true);
  });

  it('три потери за 60 с — dom, и дальше want: false навсегда', () => {
    let clock = 0;
    const policy = createWebglPolicy({ now: () => clock });
    const seen: boolean[] = [];
    policy.update('t', true);
    policy.subscribe('t', (want) => seen.push(want));
    expect(policy.onContextLoss('t')).toBe('retry');
    clock += 20_000;
    expect(policy.onContextLoss('t')).toBe('retry');
    clock += 20_000;
    expect(policy.onContextLoss('t')).toBe('dom');
    expect(seen.at(-1)).toBe(false);
    policy.update('t', false);
    policy.update('t', true);
    expect(seen.at(-1)).toBe(false);
  });

  it('потери с разницей больше 60 с — retry', () => {
    let clock = 0;
    const policy = createWebglPolicy({ now: () => clock });
    for (let i = 0; i < 5; i += 1) {
      expect(policy.onContextLoss('t')).toBe('retry');
      clock += 30_001;
    }
  });

  it('subscribe отдаёт текущее решение сразу; отписка — больше ничего', () => {
    const policy = createWebglPolicy({ keepHidden: 0 });
    policy.update('t', true);
    const seen: boolean[] = [];
    const off = policy.subscribe('t', (want) => seen.push(want));
    expect(seen).toEqual([true]);
    off();
    policy.update('t', false);
    expect(seen).toEqual([true]);
  });
});
