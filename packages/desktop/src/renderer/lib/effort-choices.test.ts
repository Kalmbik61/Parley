/** Уровни effort для окна (нормалайзер модели и effort 2026-10-06, 5.1 и 5.3): те же правила, что `effortsFor` core. */

import { describe, expect, it } from 'vitest';
import type { EffortOption, ModelOption } from '@parley/protocol';
import { effortChoices, LEGACY_EFFORTS } from './effort-choices.js';

const FIVE: EffortOption[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra high' },
  { id: 'max', label: 'Max' },
];
const ULTRA: EffortOption = { id: 'ultra', label: 'Ultra', description: 'Maximum reasoning with automatic task delegation' };
const SOL: ModelOption = { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', efforts: [...FIVE, ULTRA] };
const LUNA: ModelOption = { id: 'gpt-6-luna', label: 'GPT-6-Luna', efforts: FIVE };
const OPUS: ModelOption = { id: 'opus', label: 'Opus', efforts: FIVE };
const HAIKU: ModelOption = { id: 'haiku', label: 'Haiku', efforts: null };
const ids = (levels: readonly EffortOption[] | null): string[] | null => (levels === null ? null : levels.map((level) => level.id));

describe('effortChoices', () => {
  it('провайдер не принимает effort (false, поля нет) или ответа providers.list ещё нет — null', () => {
    expect(effortChoices(undefined, null)).toBeNull();
    expect(effortChoices({ models: [OPUS] }, 'opus')).toBeNull();
    expect(effortChoices({ models: [OPUS], effort: false }, 'opus')).toBeNull();
  });

  it('модель со списком — её уровни по порядку; у Haiku (efforts: null) — null', () => {
    expect(ids(effortChoices({ models: [SOL, LUNA], effort: true }, 'gpt-6.1-sol'))).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    expect(ids(effortChoices({ models: [SOL, LUNA], effort: true }, 'gpt-6-luna'))).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(effortChoices({ models: [OPUS, HAIKU], effort: true }, 'haiku')).toBeNull();
  });

  it('модель Default — уровни, общие для моделей с непустым списком, в порядке первой; Haiku не в счёт; общих нет — null', () => {
    expect(ids(effortChoices({ models: [SOL, LUNA], effort: true }, null))).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(ids(effortChoices({ models: [HAIKU, OPUS], effort: true }, null))).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(effortChoices({ models: [HAIKU], effort: true }, null)).toBeNull();
    expect(effortChoices({ models: [{ id: 'a', label: 'A', efforts: [ULTRA] }, LUNA], effort: true }, null)).toBeNull();
  });

  it('старый хост (у моделей нет поля efforts, effort: true) — прежние три уровня и у модели, и у Default', () => {
    const old = { models: [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }], effort: true };
    expect(effortChoices(old, 'opus')).toBe(LEGACY_EFFORTS);
    expect(ids(effortChoices(old, null))).toEqual(['low', 'medium', 'high']);
  });

  it('списка моделей нет (null, пусто, нет поля) или модели в нём нет — прежние три уровня', () => {
    expect(effortChoices({ models: null, effort: true }, null)).toBe(LEGACY_EFFORTS);
    expect(effortChoices({ models: [], effort: true }, null)).toBe(LEGACY_EFFORTS);
    expect(effortChoices({ effort: true }, 'anything')).toBe(LEGACY_EFFORTS);
    expect(effortChoices({ models: [OPUS], effort: true }, 'gone')).toBe(LEGACY_EFFORTS);
  });

  it('пустой список уровней модели окно показывает как null — поля нет', () => {
    expect(effortChoices({ models: [{ id: 'bare', label: 'Bare', efforts: [] }], effort: true }, 'bare')).toBeNull();
  });

  it('LEGACY_EFFORTS — low, medium, high с подписями окна', () => {
    expect(LEGACY_EFFORTS).toEqual([
      { id: 'low', label: 'Low' },
      { id: 'medium', label: 'Medium' },
      { id: 'high', label: 'High' },
    ]);
  });
});
