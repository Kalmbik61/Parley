import { NO_CHANNEL_WARNING } from '@harnas/core';
import { describe, expect, it } from 'vitest';
import { unseenWarnings } from './use-panel.js';

describe('unseenWarnings', () => {
  it('одно предупреждение на работу, сколько её сессий ни запусти', () => {
    const shown = new Set<string>();

    expect(unseenWarnings(shown, '/dev w-0001', [NO_CHANNEL_WARNING])).toEqual([
      NO_CHANNEL_WARNING,
    ]);
    // Второй запуск той же работы: предупреждение про работу, а не про сессию,
    // и повтор поднимал бы `⚑N` заново (8.32).
    expect(unseenWarnings(shown, '/dev w-0001', [NO_CHANNEL_WARNING])).toEqual([]);
  });

  it('у другой работы то же предупреждение показывается заново', () => {
    const shown = new Set<string>();
    unseenWarnings(shown, '/dev w-0001', [NO_CHANNEL_WARNING]);

    expect(unseenWarnings(shown, '/dev w-0002', [NO_CHANNEL_WARNING])).toEqual([
      NO_CHANNEL_WARNING,
    ]);
  });

  it('разные предупреждения одной работы показываются оба', () => {
    const shown = new Set<string>();

    expect(
      unseenWarnings(shown, '/dev w-0001', [NO_CHANNEL_WARNING, 'push выключен: claude']),
    ).toEqual([NO_CHANNEL_WARNING, 'push выключен: claude']);
  });
});
