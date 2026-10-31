/**
 * Формат заполненности контекста (спека 2026-10-15, 3.1–3.3): пороги цвета, текст чипа, тултип, числа поповера и
 * максимум для значка комнаты. Уровень считается по округлённому проценту: чип «60%» не бывает нейтральным.
 */

import type { ContextFill, WorkSession } from '@parley/core';
import { COMPACT_MAX_INSTRUCTIONS } from '@parley/protocol';
import type { CompactionPhase } from '@parley/protocol';
import { S } from '../../shared/strings.js';
import type { ActivityEntry } from '../store/activity.js';
import { knownTokens } from './usage-format.js';

const C = S.context;

export const CONTEXT_WARN_PERCENT = 60;
export const CONTEXT_CRITICAL_PERCENT = 85;
export { COMPACT_MAX_INSTRUCTIONS };

/**
 * Текст по умолчанию (`build(name)`) в пределе хоста: длинное название обрезается с «…» по знакам UTF-16, не
 * разрывая суррогатную пару. Короткое остаётся как есть.
 */
export function fitDefaultInstructions(build: (name: string) => string, name: string): string {
  if (build(name).length <= COMPACT_MAX_INSTRUCTIONS) return build(name);
  const budget = Math.max(0, COMPACT_MAX_INSTRUCTIONS - build('…').length);
  let end = Math.min(name.length, budget);
  const last = name.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return build(`${name.slice(0, end).trimEnd()}…`);
}

export type ContextLevel = 'normal' | 'warn' | 'critical';

export function contextLevel(percent: number): ContextLevel {
  const rounded = Math.round(percent);
  if (rounded >= CONTEXT_CRITICAL_PERCENT) return 'critical';
  return rounded >= CONTEXT_WARN_PERCENT ? 'warn' : 'normal';
}

/** Чип: янтарный — `accent`, красный — `destructive`; нейтральный — как соседние чипы. */
export const LEVEL_CLASS: Record<ContextLevel, string> = {
  normal: '',
  warn: 'border-accent bg-accent-200 text-accent-800',
  critical: 'border-destructive text-destructive',
};

/** Полоса заполнения в списке комнаты. */
export const BAR_CLASS: Record<ContextLevel, string> = {
  normal: 'bg-[color-mix(in_srgb,currentColor_45%,transparent)]',
  warn: 'bg-accent',
  critical: 'bg-destructive',
};

export const percentText = (percent: number): string => `${Math.round(percent)}%`;

export function contextChipText(context: ContextFill | null, compaction: CompactionPhase | null): string {
  if (compaction !== null) return C.marks[compaction];
  return context === null ? C.marks.unknown : percentText(context.usedPercent);
}

const tokensKnown = (context: ContextFill): context is ContextFill & { usedTokens: number; windowTokens: number } =>
  context.usedTokens !== null && context.windowTokens !== null;

export function contextTooltip(context: ContextFill | null, compaction: CompactionPhase | null): string {
  if (compaction !== null) return C.tooltip[compaction];
  if (context === null) return C.tooltip.unknown;
  return tokensKnown(context)
    ? C.tooltip.tokens(knownTokens(context.usedTokens), knownTokens(context.windowTokens))
    : C.tooltip.percent(percentText(context.usedPercent));
}

export function contextNumbers(context: ContextFill | null): string {
  if (context === null) return C.marks.unknown;
  return tokensKnown(context)
    ? C.numbers(knownTokens(context.usedTokens), knownTokens(context.windowTokens), percentText(context.usedPercent))
    : percentText(context.usedPercent);
}

/** Значок комнаты: наибольший известный процент; никого — `null`. */
export function maxContext(contexts: ReadonlyArray<ContextFill | null | undefined>): number | null {
  const known = contexts.filter((context): context is ContextFill => context != null).map((context) => context.usedPercent);
  return known.length === 0 ? null : Math.max(...known);
}

/**
 * Поля контекста участника из сессии карты и живой активности — одно место для ленты комнаты и строки сайдбара. У не
 * `active` — `null`; ключа нет, когда хост поля не прислал (старый хост), — тогда значка контекста у комнаты нет.
 */
export function liveContext(
  session: WorkSession,
  live: ActivityEntry | null | undefined,
): { context?: ContextFill | null; compaction?: CompactionPhase | null } {
  const active = session.lifecycle === 'active';
  const context = active ? live?.metrics?.context : null;
  const compaction = active ? live?.metrics?.compaction : null;
  return {
    ...(context === undefined ? {} : { context }),
    ...(compaction === undefined ? {} : { compaction }),
  };
}
