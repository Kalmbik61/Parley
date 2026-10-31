/**
 * Расход по отрезкам (спека передачи сессии, 5.9): закрытые отрезки лежат в `previousAgents[].usage`, текущий считается
 * по логу с конца последней привязки. Итог — сумма отрезков; копии прежних ответов, которые форк или то же
 * продолжение несут в своём логе, второй раз не входят: окно по времени плюс отсечение по id ответов прежних отрезков.
 */

import type { UsageResolver } from './room-usage.js';
import type { AgentBinding, WorkSession } from './types.js';
import { sumUsage, type FrozenUsage, type UsageSummary, type UsageWindow } from './usage-ledger.js';

const EPOCH = '1970-01-01T00:00:00.000Z';

/** Закрытый отрезок в публичном виде: без связывания с разговором и эпохи. */
export function bindingUsage(binding: AgentBinding): UsageSummary {
  const frozen: FrozenUsage | undefined = binding.usage;
  if (frozen === undefined) {
    return {
      input: null,
      output: null,
      cacheRead: null,
      cacheWrite: null,
      totalInput: null,
      source: 'unavailable',
      observedAt: null,
      stale: false,
      completeness: 'unknown',
      coverage: 'conversation',
    };
  }
  return {
    input: frozen.input,
    output: frozen.output,
    cacheRead: frozen.cacheRead,
    cacheWrite: frozen.cacheWrite,
    totalInput: frozen.totalInput,
    source: frozen.source,
    observedAt: frozen.observedAt,
    stale: frozen.stale,
    completeness: frozen.completeness,
    coverage: frozen.coverage,
  };
}

/** Сумма отрезков: неизвестный счётчик делает сумму неизвестной, полнота не выше худшей. */
export function sumSegments(usages: readonly UsageSummary[]): UsageSummary {
  const total = sumUsage(usages.map((usage, index) => ({ key: `segment:${index}`, usage })));
  const observed = usages.flatMap((usage) => (usage.observedAt === null ? [] : [usage.observedAt])).sort();
  return {
    input: total.input,
    output: total.output,
    cacheRead: total.cacheRead,
    cacheWrite: total.cacheWrite,
    totalInput: total.totalInput,
    source: 'native-index',
    observedAt: observed.at(-1) ?? null,
    stale: total.stale,
    completeness: total.completeness,
    coverage: usages.some((usage) => usage.coverage === 'conversation-and-descendants') ? 'conversation-and-descendants' : 'conversation',
  };
}

/** Окна `windows` не раньше `from`; окно целиком до `from` отбрасывается. */
function clipFrom(windows: readonly UsageWindow[], from: string): UsageWindow[] {
  const start = Date.parse(from);
  const clipped: UsageWindow[] = [];
  for (const window of windows) {
    if (window.to !== null && Date.parse(window.to) <= start) continue;
    clipped.push({ from: Date.parse(window.from) < start ? from : window.from, to: window.to });
  }
  return clipped;
}

/**
 * Расход текущего отрезка сессии с прежними привязками: записи лога после конца последней, без ответов, уже
 * учтённых прежними отрезками. `within` — дополнительно только эти окна (участие в комнате). `null` — лога нет.
 */
export async function currentSegmentUsage(
  session: WorkSession,
  resolver: UsageResolver,
  within?: readonly UsageWindow[],
): Promise<UsageSummary | null> {
  const prior = session.previousAgents ?? [];
  const last = prior.at(-1)?.endedAt;
  if (last === undefined) return within === undefined ? resolver.whole(session) : resolver.slice(session, within);
  const windows = within === undefined ? [{ from: last, to: null }] : clipFrom(within, last);
  if (windows.length === 0) return null;
  const excluded = new Set<string>();
  if (resolver.ids !== undefined) {
    for (const binding of prior) {
      if (binding.providerSessionId === null) continue;
      const earlier = { ...session, provider: binding.provider, providerSessionId: binding.providerSessionId };
      const ids = await resolver.ids(earlier, [{ from: binding.startedAt ?? EPOCH, to: binding.endedAt }]);
      for (const id of ids ?? []) excluded.add(id);
    }
  }
  return resolver.slice(session, windows, excluded);
}
