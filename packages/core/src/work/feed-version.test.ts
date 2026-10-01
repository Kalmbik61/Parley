/** Порог версии `claude` для ленты вида «Chat» (план 2026-10-01, Global Constraints). */

import { describe, expect, it } from 'vitest';
import { FEED_MIN_VERSION, feedSupported } from './feed-version.js';

describe('feedSupported', () => {
  it('порог — версия стенда разведки', () => {
    expect(FEED_MIN_VERSION).toBe('2.1.286');
  });

  it('2.1.285 — нет, 2.1.286 — да, новее — да', () => {
    expect(feedSupported('2.1.285 (Claude Code)')).toBe(false);
    expect(feedSupported('2.1.286 (Claude Code)')).toBe(true);
    expect(feedSupported('2.1.300')).toBe(true);
    expect(feedSupported('2.2.0')).toBe(true);
    expect(feedSupported('3.0.0')).toBe(true);
    expect(feedSupported('2.0.999')).toBe(false);
    expect(feedSupported('1.9.400')).toBe(false);
  });

  it('мусор и пустая строка — нет: непонятную версию считаем старой', () => {
    expect(feedSupported('')).toBe(false);
    expect(feedSupported('garbage')).toBe(false);
    expect(feedSupported('2.1')).toBe(false);
    expect(feedSupported('claude: command not found')).toBe(false);
  });
});
