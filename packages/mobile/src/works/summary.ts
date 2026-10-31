import type { WorkView } from '@parley/remote-client';

/** Second line of a Works row: open sessions, rooms and swarms, working count or "idle" (D1 §8.1). */
export function worksSummary(v: Pick<WorkView, 'work' | 'rows'>): string {
  const workingCount = v.rows.filter((r) => r.kind === 'session' && r.attention === 'working').length;
  const open = v.work.sessions.filter((s) => s.lifecycle !== 'closed').length;
  const rooms = v.work.rooms.filter((r) => !r.archived).length;
  const swarms = v.work.swarms.length;
  const parts = [`${open} session${open === 1 ? '' : 's'}`];
  if (rooms > 0) parts.push(`${rooms} room${rooms === 1 ? '' : 's'}`);
  if (swarms > 0) parts.push(`${swarms} swarm${swarms === 1 ? '' : 's'}`);
  parts.push(workingCount > 0 ? `${workingCount} working` : 'idle');
  return parts.join(' · ');
}

/** Same project → same colour on the Mac and the phone: FNV-1a of the path over three palette steps (desktop `project-color.ts`). */
const PALETTE = ['#D98C5F', '#5FA8A0', '#9A9A9A'] as const;

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export const projectColor = (projectPath: string): string => PALETTE[fnv1a(projectPath) % PALETTE.length] as string;
