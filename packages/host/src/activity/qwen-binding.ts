import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { byFamily, qwenBindingCandidate, type WorkSession } from '@parley/core';
import type { Log } from '../log.js';
import type { SessionRef } from '@parley/protocol';

export interface QwenBindingDeps {
  log: Log;
  qwenRoot: string;
  session(ref: SessionRef): WorkSession | undefined;
  /** Writes the binding into the session map (`updateMap`). */
  store(ref: SessionRef, binding: { path: string; cwd: string }): Promise<void>;
}

const samePath = async (a: string, b: string): Promise<boolean> => {
  if (path.resolve(a) === path.resolve(b)) return true;
  try {
    return (await realpath(a)) === (await realpath(b));
  } catch {
    return false;
  }
};

/**
 * Stores `SessionStart`'s `transcript_path` of a Qwen session in the session map (spec 3.5, Binding). The binding survives
 * a host restart; the log index trusts the file only while its records' `sessionId` and `cwd` agree. A path whose shape,
 * name, `session_id` or `cwd` does not fit the session is not stored. The directory name is never decoded into a cwd.
 */
export function createQwenBinding(deps: QwenBindingDeps): { onHook(request: { ref: SessionRef; body: Record<string, unknown> }): Promise<void> } {
  return {
    async onHook({ ref, body }) {
      if (body['hook_event_name'] !== 'SessionStart') return;
      const session = deps.session(ref);
      if (session === undefined || session.providerSessionId === null) return;
      if (!byFamily(session.provider, { claude: false, codex: false, qwen: true, opencode: false, neutral: false })) return;
      const candidate = qwenBindingCandidate(body, session.providerSessionId, deps.qwenRoot);
      if (candidate === null) return;
      const folder = session.workspace?.path ?? session.worktree?.path ?? ref.projectPath;
      if (!(await samePath(candidate.cwd, folder))) {
        deps.log.warn('qwen transcript binding refused: cwd differs from the session folder', { sessionId: ref.sessionId });
        return;
      }
      const current = session.qwenTranscript;
      if (current?.path === candidate.path && current.cwd === candidate.cwd) return;
      try {
        await deps.store(ref, candidate);
      } catch (error) {
        deps.log.warn(`qwen transcript binding was not stored: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}
