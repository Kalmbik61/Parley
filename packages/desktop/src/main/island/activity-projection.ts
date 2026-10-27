import { createHash } from 'node:crypto';
import type { LiveTask } from '@parley/protocol';
import type { IslandActivityEntry } from '../../shared/island.js';

const count = (value: number): number => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const measure = (value: number | null): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/** Best effort policy B; произвольный секрет в свободном тексте не распознаётся гарантированно. */
function label(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null;
  let text = value.replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu, '');
  text = text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/\b(Bearer|Basic)\s+[a-z0-9._~+/=-]+/gi, '$1 [redacted]')
    .replace(/\b[\w.-]*(?:api[_-]?key|token|secret|password|passwd|authorization|access[_-]?key)[\w.-]*["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi, '[redacted]')
    .replace(/\b(?:sk-[a-z0-9_-]+|gh[pousr]_[a-z0-9_-]+|github_pat_[a-z0-9_]+|AKIA[A-Z0-9]{16})\b/gi, '[redacted]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted]');
  let bounded = '';
  for (const char of text.trim()) {
    if (bounded.length + char.length > limit) break;
    bounded += char;
  }
  return bounded || null;
}

export function projectIslandActivity(entry: IslandActivityEntry): IslandActivityEntry {
  const activity = entry.activity;
  const projected: IslandActivityEntry = { ref: { projectPath: entry.ref.projectPath, workId: entry.ref.workId, sessionId: entry.ref.sessionId }, activity: {
    activity: activity.activity, subagents: count(activity.subagents), tasks: [], waitingFor: null,
    heldByBackground: activity.heldByBackground === true, turnEndedAt: activity.turnEndedAt, lastEventAt: activity.lastEventAt,
    source: activity.source, hooksMissing: activity.hooksMissing,
    need: activity.need == null ? null : { kind: activity.need.kind, since: activity.need.since, detail: null,
      resetsAt: activity.need.resetsAt, window: activity.need.window, account: activity.need.account },
  }, metrics: null };
  const metrics = entry.metrics;
  if (metrics === null) return projected;
  const tasks: LiveTask[] = [];
  if (Array.isArray(metrics.tasks)) {
    const seen = new Set<string>();
    for (const raw of metrics.tasks) {
      if (raw === null || typeof raw !== 'object' || typeof raw.id !== 'string' || raw.id.trim().length === 0 || seen.has(raw.id)) continue;
      seen.add(raw.id);
      if (tasks.length >= 8) continue;
      const id = createHash('sha256').update(raw.id).digest('hex');
      try {
        tasks.push({ id, agentType: label(raw.agentType, 48) ?? 'Subagent', description: label(raw.description, 160), background: raw.background === true });
      } catch { tasks.push({ id, agentType: 'Subagent', description: null, background: false }); }
    }
    projected.islandTasksTotal = seen.size;
  }
  projected.metrics = { tokensIn: measure(metrics.tokensIn), tokensOut: measure(metrics.tokensOut), durationMs: measure(metrics.durationMs),
    unread: count(metrics.unread), subagents: count(metrics.subagents), model: null,
    ...(projected.islandTasksTotal === undefined ? {} : { tasks }),
  };
  return projected;
}
