import { describe, expect, it } from 'vitest';
import type { LiveMetrics } from '@parley/protocol';
import { formatMetricsLine } from './metrics-line.js';

function metrics(patch: Partial<LiveMetrics> = {}): LiveMetrics {
  return {
    tokensIn: null,
    tokensOut: null,
    durationMs: null,
    unread: 0,
    subagents: 0,
    model: null,
    ...patch,
  };
}

describe('formatMetricsLine', () => {
  it('токенов нет — тире вместо стрелок', () => {
    expect(formatMetricsLine(metrics())).toBe('— · —');
  });

  it('тысячи — с «k», минуты — с «m»', () => {
    const line = formatMetricsLine(metrics({ tokensIn: 1200, tokensOut: 845, durationMs: 12 * 60_000 }));
    expect(line).toBe('↑1.2k ↓845 · 12m');
  });

  it('нулевые ▤ и ⋮ не печатаются', () => {
    const line = formatMetricsLine(metrics({ tokensIn: 100, tokensOut: 0, durationMs: 1000, subagents: 0, unread: 0 }));
    expect(line).not.toContain('▤');
    expect(line).not.toContain('⋮');
  });

  it('ненулевые ▤ и ⋮ печатаются', () => {
    const line = formatMetricsLine(
      metrics({ tokensIn: 1200, tokensOut: 845, durationMs: 12 * 60_000, subagents: 1, unread: 1 }),
    );
    expect(line).toBe('↑1.2k ↓845 · 12m · ▤1 · ⋮1');
  });

  // Кусок 4b: хост со списком живых субагентов показывает их бейджем в строке сессии — ▤N в тултипе не повторяется.
  it('есть список субагентов (tasks) — ▤N не печатается, ⋮ остаётся; списка нет (хост прежней версии) — ▤N как был', () => {
    const task = { id: 'a', agentType: 'Explore', description: 'Look around', background: true };
    expect(formatMetricsLine(metrics({ subagents: 1, unread: 1, tasks: [task] }))).toBe('— · — · ⋮1');
    expect(formatMetricsLine(metrics({ subagents: 0, tasks: [] }))).toBe('— · —');
    expect(formatMetricsLine(metrics({ subagents: 1, unread: 1 }))).toBe('— · — · ▤1 · ⋮1');
  });

  describe('usage хоста с происхождением цифр (P36)', () => {
    const usage = (patch: Partial<NonNullable<LiveMetrics['usage']>> = {}): NonNullable<LiveMetrics['usage']> => ({
      input: 1000,
      output: 200,
      cacheRead: 300,
      cacheWrite: 50,
      totalInput: 1350,
      source: 'native-index',
      observedAt: '2026-10-04T12:00:01.000Z',
      stale: false,
      completeness: 'complete',
      coverage: 'conversation',
      ...patch,
    });

    it('свежий живой замер: кэш рядом с токенами, без пометок', () => {
      const line = formatMetricsLine(metrics({ tokensIn: 1000, tokensOut: 200, durationMs: 60_000, usage: usage() }));
      expect(line).toBe('↑1.0k ↓200 · cache r300 w50 · 1m');
    });

    it('кэш не сообщён — «?», а не 0; измеренный ноль остаётся нулём', () => {
      expect(formatMetricsLine(metrics({ tokensIn: 800, tokensOut: 200, usage: usage({ cacheRead: 200, cacheWrite: null }) }))).toBe(
        '↑800 ↓200 · cache r200 w? · —',
      );
      expect(formatMetricsLine(metrics({ tokensIn: 800, tokensOut: 200, usage: usage({ cacheRead: 0, cacheWrite: 0 }) }))).toBe(
        '↑800 ↓200 · cache r0 w0 · —',
      );
    });

    it('кэша нет совсем (оба неизвестны) — сегмент не печатается', () => {
      const line = formatMetricsLine(metrics({ tokensIn: 100, tokensOut: 20, usage: usage({ cacheRead: null, cacheWrite: null, totalInput: null }) }));
      expect(line).toBe('↑100 ↓20 · —');
    });

    it('одно неизвестное число с usage — «?», а не измеренный ноль', () => {
      const line = formatMetricsLine(metrics({ tokensIn: null, tokensOut: 20, usage: usage({ input: null, cacheRead: null, cacheWrite: null }) }));
      expect(line).toBe('↑? ↓20 · —');
    });

    it('снимок, устаревшее и неполное помечаются', () => {
      const snapshot = usage({ source: 'frozen-snapshot', stale: true, completeness: 'partial', cacheRead: null, cacheWrite: null });
      expect(formatMetricsLine(metrics({ tokensIn: 100, tokensOut: 20, usage: snapshot }))).toBe('↑100 ↓20 · snapshot stale partial · —');
      expect(formatMetricsLine(metrics({ usage: usage({ source: 'unavailable', input: null, output: null, cacheRead: null, cacheWrite: null, totalInput: null, completeness: 'unknown', stale: true }) }))).toBe(
        '— · n/a stale · —',
      );
    });

    it('токены не называются деньгами и долей лимита', () => {
      const line = formatMetricsLine(metrics({ tokensIn: 1000, tokensOut: 200, usage: usage({ stale: true, completeness: 'partial' }) }));
      expect(line).not.toMatch(/\$|%|cost|quota|limit|saving/i);
    });

    it('хост прежней версии без usage: строка как была, включая 0 при одном неизвестном числе', () => {
      expect(formatMetricsLine(metrics({ tokensIn: 100, tokensOut: 20 }))).toBe('↑100 ↓20 · —');
      expect(formatMetricsLine(metrics({ tokensIn: 100, tokensOut: null }))).toBe('↑100 ↓0 · —');
    });
  });
});
