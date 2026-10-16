/**
 * Расход токенов в окне (спека расхода токенов, 3): текст значка, пометки строк, подписи и Markdown для Copy. Это токены,
 * а не деньги и не доля лимита подписки; неизвестное — `?`, а не `0`.
 */

import type { RoomUsage, RoomUsageMember, UsageCounters, UsageSummary } from '@parley/core';
import { S } from '../../shared/strings.js';
import { formatTokens } from './metrics-line.js';
import { sessionRowLabel } from './participant.js';

const U = S.usage;

/** Счётчик строкой: неизвестный — `?`. */
export const knownTokens = (value: number | null): string => (value === null ? '?' : formatTokens(value));

/** Значок: `↑1.2M ↓84k`; нижняя граница — с `≥` впереди. */
export function usageChipText(value: { input: number | null; output: number | null; completeness: string }): string {
  const text = `↑${knownTokens(value.input)} ↓${knownTokens(value.output)}`;
  return value.completeness === 'partial' ? `≥ ${text}` : text;
}

/** Четыре колонки: In, Out, Cache read, Cache write. Строки без цифр — `?`. */
export const usageCells = (counters: UsageCounters | null): string[] =>
  counters === null ? ['?', '?', '?', '?'] : [counters.input, counters.output, counters.cacheRead, counters.cacheWrite].map(knownTokens);

/** Пометки итога сессии — те же слова, что в строке метрик сайдбара (`formatMetricsLine`). */
export function usageMarks(usage: UsageSummary): string[] {
  const marks: string[] = [];
  if (usage.source === 'unavailable') marks.push(U.notAvailable);
  if (usage.source === 'frozen-snapshot' || usage.source === 'legacy-snapshot') marks.push(U.snapshot);
  if (usage.stale) marks.push(U.stale);
  if (usage.completeness === 'partial') marks.push(U.partial);
  return marks;
}

/** Пометки строки участника (3.2): одинаковые в поповере и в Markdown. */
export function memberMarks(member: RoomUsageMember): string[] {
  if (member.status === 'not-started') return [U.notStarted];
  if (member.status === 'unavailable') return [member.reason === 'deleted' ? U.sessionDeleted : U.logMissing];
  const marks = member.usage === null ? [] : usageMarks(member.usage);
  const last = member.periods[member.periods.length - 1];
  if (!member.current && last?.to != null) marks.push(U.left(last.to));
  if (member.sharedWith.length > 0) marks.push(U.sharedWith(member.sharedWith));
  return marks;
}

export interface UsageLabels {
  /** `S01 Planner · lead · Claude`. */
  member(member: RoomUsageMember): string;
  /** Только название: `S01 Planner`. */
  memberName(member: RoomUsageMember): string;
  /** Подписи после названия: `lead`, провайдер (удалённая сессия — без него). */
  memberTags(member: RoomUsageMember): string[];
  provider(id: string): string;
}

/** Подписи строк по сессиям карты и списку провайдеров (`providers.list`); незнакомый провайдер — его id. */
export function createUsageLabels(
  sessions: ReadonlyArray<{ id: string; label: string }>,
  providers: ReadonlyArray<{ id: string; label: string }>,
): UsageLabels {
  const provider = (id: string): string => providers.find((item) => item.id === id)?.label ?? id;
  const labels: UsageLabels = {
    provider,
    memberName: (member) => {
      const label = sessions.find((session) => session.id === member.sessionId)?.label ?? '';
      return sessionRowLabel(member.sessionId, label);
    },
    memberTags: (member) => [...(member.lead ? [U.lead] : []), ...(member.provider === null ? [] : [provider(member.provider)])],
    member: (member) => [labels.memberName(member), ...labels.memberTags(member)].join(' · '),
  };
  return labels;
}

const two = (value: number): string => String(value).padStart(2, '0');

/** Местное время отчёта: `2026-10-14 12:03`. */
export function usageStamp(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** Ячейка таблицы Markdown: `|` и перевод строки ломали бы строку таблицы. */
const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

const withMarks = (label: string, marks: readonly string[]): string => (marks.length === 0 ? label : `${label} (${marks.join(', ')})`);

/** Таблица для Copy (3.3): итог, провайдеры (если их больше одного), участники, примечания. */
export function usageMarkdown(usage: RoomUsage, title: string, labels: UsageLabels): string {
  const row = (label: string, counters: UsageCounters | null): string => `| ${label} | ${usageCells(counters).join(' | ')} |`;
  const totalMarks = (completeness: string): string[] => (completeness === 'partial' ? [U.partial] : []);
  const lines = [
    `**${U.markdownTitle(title, usage.roomId)}**`,
    `${U.since} · ${usageStamp(usage.computedAt)}`,
    '',
    `| | ${U.columns.join(' | ')} |`,
    '|---|---:|---:|---:|---:|',
    row(withMarks(`**${U.total}**`, totalMarks(usage.total.completeness)), usage.total),
  ];
  if (usage.byProvider.length > 1) {
    for (const item of usage.byProvider) {
      lines.push(row(withMarks(cell(labels.provider(item.provider)), totalMarks(item.total.completeness)), item.total));
    }
  }
  for (const member of usage.members) lines.push(row(withMarks(cell(labels.member(member)), memberMarks(member)), member.usage));
  lines.push('', `${U.footnote} ${U.legend}`);
  if (usage.reconstructed) lines.push(U.reconstructed);
  return lines.join('\n');
}
