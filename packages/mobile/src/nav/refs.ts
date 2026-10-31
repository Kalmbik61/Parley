// Route params for screens that take a session or a work. Paths and ids can hold any character, so each part is
// percent-encoded and joined with `|` (never produced by encodeURIComponent).
import type { SessionRef } from '@parley/remote-client';

const enc = (parts: string[]): string => parts.map(encodeURIComponent).join('|');
const dec = (param: string, n: number): string[] | null => {
  const parts = param.split('|');
  if (parts.length !== n) return null;
  try {
    return parts.map(decodeURIComponent);
  } catch {
    return null;
  }
};

export const sessionParam = (ref: SessionRef): string => enc([ref.projectPath, ref.workId, ref.sessionId]);
export function parseSessionParam(param: string | undefined): SessionRef | null {
  const p = param === undefined ? null : dec(param, 3);
  return p === null || p.some((x) => x === '') ? null : { projectPath: p[0]!, workId: p[1]!, sessionId: p[2]! };
}

export interface WorkRef {
  projectPath: string;
  workId: string;
}
export const workParam = (ref: WorkRef): string => enc([ref.projectPath, ref.workId]);
export function parseWorkParam(param: string | undefined): WorkRef | null {
  const p = param === undefined ? null : dec(param, 2);
  return p === null || p.some((x) => x === '') ? null : { projectPath: p[0]!, workId: p[1]! };
}
