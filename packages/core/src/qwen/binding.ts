import path from 'node:path';
import type { SessionIndex } from '../session-index.js';
import { isQwenTranscriptPath, qwenLogId } from './discover.js';

/** What the session map keeps of the Qwen transcript binding (from `SessionStart`'s `transcript_path`). */
export interface QwenTranscriptBinding {
  path: string;
  /** `cwd` of `SessionStart`: the records of the file must carry the same one. */
  cwd: string;
}

/**
 * The binding from a `SessionStart` body (`transcript_path`, `cwd`, `session_id`), if it can be this session's transcript: absolute, shaped
 * `<root>/<project>/chats/<sessionId>.jsonl`, and named after the session's id (and `session_id`, when sent) with a non-empty `cwd`. The directory name is never decoded.
 */
export function qwenBindingCandidate(
  body: Record<string, unknown>,
  sessionId: string,
  root: string,
): QwenTranscriptBinding | null {
  const { transcript_path: file, cwd, session_id: native } = body;
  if (typeof file !== 'string' || !path.isAbsolute(file) || typeof cwd !== 'string' || cwd === '') return null;
  if (native !== undefined && native !== sessionId) return null;
  if (!isQwenTranscriptPath(file, root)) return null;
  return qwenLogId(path.basename(file)) === sessionId.toLowerCase() ? { path: file, cwd } : null;
}

/**
 * A bound transcript is trusted only when its records name the same `sessionId` and the same `cwd` that `SessionStart`
 * reported (the host checked that cwd against the session's folder when it stored the binding), and it is the bound file.
 */
export function qwenBindingHolds(
  index: Pick<SessionIndex, 'id' | 'cwd' | 'file'>,
  expected: { sessionId: string; binding: QwenTranscriptBinding },
): boolean {
  return (
    index.file === expected.binding.path &&
    index.id.toLowerCase() === expected.sessionId.toLowerCase() &&
    index.cwd !== null &&
    index.cwd === expected.binding.cwd
  );
}
