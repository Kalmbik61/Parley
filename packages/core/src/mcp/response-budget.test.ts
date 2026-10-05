import { describe, expect, it } from 'vitest';
import { GUIDE, GUIDE_TOPICS } from '../work/guide.js';
import { READ_GUIDE_MAX_BYTES, contextBytes } from '../work/context-budget.js';
import { boundedGuide } from './tools.js';

describe('ограничение ответа read_guide', () => {
  it('весь гид сегодня в пределах потолка и отдаётся как есть', () => {
    expect(contextBytes(GUIDE)).toBeLessThan(READ_GUIDE_MAX_BYTES);
    expect(boundedGuide(GUIDE, 'The whole guide')).toBe(GUIDE);
  });

  it('сверх потолка вместо обрезанного текста — размер, потолок и список тем', () => {
    const answer = boundedGuide(GUIDE, 'The whole guide', 1000);
    expect(answer).toContain(`${contextBytes(GUIDE)} bytes, over the 1000-byte limit`);
    for (const { topic } of GUIDE_TOPICS) expect(answer).toContain(topic);
    expect(answer.length).toBeLessThan(1000);
    expect(GUIDE.startsWith(answer.slice(0, 40))).toBe(false);
  });
});
