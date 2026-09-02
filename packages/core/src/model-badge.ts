import { SYNTHETIC_MODEL } from './counters.js';
import { PROVIDERS } from './providers.js';
import type { Provider } from './session-index.js';

/**
 * Правила нормализации имени модели в бейдж (specs/runners.md).
 * Порядок важен: `gpt-5.2-codex` должен попасть в Codex раньше, чем в GPT.
 */
const RULES: ReadonlyArray<{ pattern: RegExp; badge: string }> = [
  { pattern: /^claude-opus\b/, badge: 'Opus' },
  { pattern: /^claude-sonnet\b/, badge: 'Sonnet' },
  { pattern: /^claude-haiku\b/, badge: 'Haiku' },
  { pattern: /^claude-fable\b/, badge: 'Fable' },
  { pattern: /codex/, badge: 'Codex' },
  { pattern: /^(gpt|o\d)\b/, badge: 'GPT' },
  { pattern: /^glm\b/, badge: 'GLM' },
];

/** Столько символов помещается в узкую колонку под незнакомое имя модели. */
const MAX_RAW = 12;

/**
 * Короткий бейдж модели для списка. Единый для всех провайдеров: UI не должен
 * знать, чья это модель.
 *
 * `<synthetic>` — не модель, а служебная пометка Claude Code, и в бейдж не идёт.
 */
export function modelBadge(model: string | null): string {
  if (model === null || model === SYNTHETIC_MODEL) return '—';

  const normalized = model.toLowerCase();
  for (const { pattern, badge } of RULES) {
    if (pattern.test(normalized)) return badge;
  }

  // Незнакомое показываем как есть: лучше сырое имя, чем выдуманное семейство.
  return model.length > MAX_RAW ? `${model.slice(0, MAX_RAW)}…` : model;
}

/** Подпись провайдера для списка. */
export function providerBadge(provider: Provider): string {
  return PROVIDERS[provider].label;
}

/** Короткий маркер провайдера: в узкой колонке на полную подпись места нет. */
export function providerMark(provider: Provider): string {
  return PROVIDERS[provider].mark;
}
