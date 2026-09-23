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

/** Семейства Claude, у которых `modelName` сохраняет версию (дизайн комнаты, 4). */
const CLAUDE_VERSIONED = /^claude-(opus|sonnet|haiku|fable)\b(.*)$/;
const GPT_VERSIONED = /^gpt\b(.*)$/;
/** Хвост вида `20251001`: дата сборки модели, а не часть версии. */
const DATE_SUFFIX = /^\d{8}$/;

/** Числа версии из хвоста id модели, дата на конце отбрасывается. */
function versionOf(rest: string): string {
  const segments = rest.split('-').filter((segment) => segment !== '');
  const last = segments[segments.length - 1];
  const numbered = last !== undefined && DATE_SUFFIX.test(last) ? segments.slice(0, -1) : segments;
  return numbered.join('.');
}

/**
 * Имя модели с версией для подписи участника в комнате (дизайн комнаты, 4):
 * то же семейство, что у `modelBadge`, но версия не отбрасывается — иначе
 * `S01 (Opus)` и `S03 (Opus)` было бы не различить. `modelBadge` не меняется:
 * в узкой колонке сайдбара версия не нужна.
 */
export function modelName(model: string | null): string | null {
  if (model === null || model === SYNTHETIC_MODEL) return null;

  const normalized = model.toLowerCase();
  // Как и в modelBadge: gpt-5.2-codex — это Codex, а не GPT.
  if (normalized.includes('codex')) return 'Codex';

  const claude = CLAUDE_VERSIONED.exec(normalized);
  if (claude !== null) {
    const family = claude[1] as string;
    const label = `${family.charAt(0).toUpperCase()}${family.slice(1)}`;
    const version = versionOf(claude[2] as string);
    return version === '' ? label : `${label} ${version}`;
  }

  const gpt = GPT_VERSIONED.exec(normalized);
  if (gpt !== null) {
    const rest = (gpt[1] as string).replace(/^-/, '');
    return rest === '' ? 'GPT' : `GPT-${rest}`;
  }

  // Незнакомое — как есть, той же обрезкой, что и modelBadge.
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
