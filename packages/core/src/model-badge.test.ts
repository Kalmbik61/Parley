import { describe, expect, it } from 'vitest';
import { modelBadge, providerBadge, providerMark } from './model-badge.js';
import type { Provider } from './session-index.js';

describe('modelBadge', () => {
  it('семейства Claude', () => {
    expect(modelBadge('claude-opus-5')).toBe('Opus');
    expect(modelBadge('claude-opus-4-8')).toBe('Opus');
    expect(modelBadge('claude-sonnet-5')).toBe('Sonnet');
    expect(modelBadge('claude-haiku-4-5-20251001')).toBe('Haiku');
    expect(modelBadge('claude-fable-5')).toBe('Fable');
  });

  it('модели Codex распознаются раньше общего GPT', () => {
    expect(modelBadge('gpt-5.2-codex')).toBe('Codex');
    expect(modelBadge('gpt-5.1-codex-max')).toBe('Codex');
    expect(modelBadge('gpt-5.1-codex-mini')).toBe('Codex');
    expect(modelBadge('gpt-5.2')).toBe('GPT');
  });

  it('GLM и незнакомые модели', () => {
    expect(modelBadge('glm-4.6')).toBe('GLM');
    expect(modelBadge('mistral-large')).toBe('mistral-larg…');
    expect(modelBadge('своя')).toBe('своя');
  });

  it('служебные значения не становятся бейджем', () => {
    expect(modelBadge(null)).toBe('—');
    expect(modelBadge('<synthetic>')).toBe('—');
  });

  it('регистр не мешает распознаванию', () => {
    expect(modelBadge('Claude-Opus-5')).toBe('Opus');
    expect(modelBadge('GPT-5.2-CODEX')).toBe('Codex');
  });
});

describe('бейдж провайдера', () => {
  it('подпись и маркер', () => {
    expect(providerBadge('claude')).toBe('Claude');
    expect(providerBadge('codex')).toBe('Codex');
    expect(providerBadge('glm')).toBe('GLM');
    // Маркеры обязаны различаться: Claude и Codex начинаются одинаково.
    expect(providerMark('claude')).toBe('Cl');
    expect(providerMark('codex')).toBe('Cx');
    expect(providerMark('glm')).toBe('GL');
    expect(new Set((['claude', 'codex', 'glm'] as Provider[]).map(providerMark)).size).toBe(3);
  });
});
