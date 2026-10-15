import { describe, expect, it } from 'vitest';
import { S } from '../../shared/strings.js';
import {
  contextChipText,
  contextLevel,
  contextNumbers,
  contextTooltip,
  maxContext,
  percentText,
} from './context-format.js';
import { knownTokens } from './usage-format.js';

const FILL = { usedPercent: 82.4, windowTokens: 200_000, usedTokens: 164_800, at: '2026-10-15T10:00:00.000Z' };

describe('context-format (спека 3.1–3.3)', () => {
  it('пороги по округлённому проценту: < 60 нейтральный, 60–84 янтарный, ≥ 85 красный', () => {
    expect(contextLevel(59.4)).toBe('normal');
    expect(contextLevel(59.6)).toBe('warn');
    expect(contextLevel(84.4)).toBe('warn');
    expect(contextLevel(84.6)).toBe('critical');
    expect(contextLevel(100)).toBe('critical');
  });

  it('текст чипа: процент, нет данных, фазы сжатия', () => {
    expect(percentText(82.4)).toBe('82%');
    expect(contextChipText(FILL, null)).toBe('82%');
    expect(contextChipText(null, null)).toBe('—');
    expect(contextChipText(FILL, 'pending')).toBe('⏳');
    expect(contextChipText(FILL, 'running')).toBe('…');
    expect(contextChipText(null, 'compacted')).toBe('compacted');
  });

  it('тултип и числа поповера', () => {
    expect(contextTooltip(FILL, null)).toBe(`Context: ${knownTokens(164_800)} of ${knownTokens(200_000)} tokens`);
    expect(contextTooltip({ ...FILL, usedTokens: null }, null)).toBe('Context: 82% used');
    expect(contextTooltip(null, null)).toBe('No context data yet');
    expect(contextTooltip(FILL, 'pending')).toBe('Compaction queued — runs when the agent is free');
    expect(contextNumbers(FILL)).toBe(`${knownTokens(164_800)} of ${knownTokens(200_000)} tokens · 82%`);
    expect(contextNumbers(null)).toBe('—');
  });

  it('значок комнаты — наибольший известный процент', () => {
    expect(maxContext([FILL, { ...FILL, usedPercent: 41 }, null, undefined])).toBe(82.4);
    expect(maxContext([null, undefined])).toBeNull();
  });

  it('инструкции по умолчанию — с названием комнаты и сессии', () => {
    expect(S.context.roomDefault('Auth refactor')).toBe(
      'Focus on room "Auth refactor": the human\'s task, decisions made, open questions, who owns what, and files touched. Drop details unrelated to this room.',
    );
    expect(S.context.sessionDefault('S01 backend')).toBe(
      'Focus on "S01 backend": the current task, decisions made, open questions, and files touched. Drop unrelated details.',
    );
    expect(S.context.allResult(3, 1, 1)).toBe('Compacting 3 agents · 1 queued · 1 skipped');
    expect(S.context.allResult(1, 0, 0)).toBe('Compacting 1 agent');
  });
});
