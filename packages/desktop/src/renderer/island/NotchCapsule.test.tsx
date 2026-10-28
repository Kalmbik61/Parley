/** Содержимое капсулы острова: правый статус роя `🐝 3/5` (спека роя v1, 7.4) стоит ниже `✓ N Done` и выше «точка и число работающих». */

import { describe, expect, it } from 'vitest';
import { capsuleContent } from './NotchCapsule.js';

describe('capsuleContent — правый статус', () => {
  const swarm = { count: 1, handed: 3, total: 5 };

  it('рой выше работающих', () => {
    expect(capsuleContent({ active: true, working: 2, swarm }, 0, null)?.right).toEqual({ kind: 'swarm', handed: 3, total: 5 });
  });

  it('Done выше роя', () => {
    expect(capsuleContent({ active: true, working: 2, swarm }, 1, null)?.right).toEqual({ kind: 'done', count: 1 });
  });

  it('без роя — прежние «работают» и пусто', () => {
    expect(capsuleContent({ active: true, working: 2 }, 0, null)?.right).toEqual({ kind: 'working', count: 2 });
    expect(capsuleContent({ active: false, working: 0 }, 0, null)).toBeNull();
  });

  it('рой без работающих сессий — капсула стоит: слева рой агентов, справа счётчик', () => {
    expect(capsuleContent({ active: true, working: 0, swarm }, 0, null)).toEqual({ left: 'agents', right: { kind: 'swarm', handed: 3, total: 5 } });
  });
});
