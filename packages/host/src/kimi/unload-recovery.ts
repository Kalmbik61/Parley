import path from 'node:path';
import type { AppLocale } from '@parley/core/i18n';
import { HOST_ERROR_REASONS, refKey, type SessionRef } from '@parley/protocol';
import { HostError } from '../errors.js';
import { hostText, type HostText } from '../host-text.js';
import type { Log } from '../log.js';
import type { KimiNativeBinding } from './native-session.js';
import { repairKimiUnloadPoison } from './unload-repair.js';

export interface KimiUnloadRecoveryOptions {
  stop(ref: SessionRef): Promise<void>;
  resume(ref: SessionRef): Promise<void>;
  live(ref: SessionRef): boolean;
  notice(ref: SessionRef, kind: 'kimi-unload-repaired' | 'kimi-unload-blocked', text: string): void;
  locale(): AppLocale | undefined;
  log: Pick<Log, 'warn'>;
  /** Serializes with model/agent changes; a busy lock skips the attempt (the next failed turn retries). */
  serialize?<T>(ref: SessionRef, run: () => Promise<T>): Promise<T>;
}

type Episode = { attempts: number; limit: number; repaired: Set<string>; running: boolean };

/**
 * Stop → repair → resume for the Kimi Code 2.8.1 unload_tools poison (audit 2026-11-26).
 * Every attempt is driven by a fresh failed turn of the live process; attempts are bounded by the
 * number of poisoned announcements, and a tool that fails again after its announcement was removed
 * blocks the episode instead of looping. A turn that ends without the poison verifies the repair.
 */
export function createKimiUnloadRecovery(options: KimiUnloadRecoveryOptions) {
  const episodes = new Map<string, Episode>();

  function block(ref: SessionRef, tool: string, reason: HostText): void {
    episodes.delete(refKey(ref));
    const locale = options.locale();
    options.notice(ref, 'kimi-unload-blocked',
      hostText('kimiUnloadBlocked', { session: ref.sessionId, tool, reason: reason.in(locale) }).in(locale));
  }

  function turnEnd(ref: SessionRef, binding: KimiNativeBinding, id: string, poison?: { tool: string }): void {
    const key = refKey(ref);
    const episode = episodes.get(key);
    if (poison === undefined) {
      if (episode !== undefined && !episode.running) episodes.delete(key);
      return;
    }
    if (episode?.running) return;
    const tool = poison.tool;
    if (episode !== undefined) {
      if (episode.repaired.has(tool)) return block(ref, tool, hostText('kimiUnloadReasonRepeat'));
      if (episode.attempts >= episode.limit) return block(ref, tool, hostText('kimiUnloadReasonLimit'));
    }
    const state: Episode = episode ?? { attempts: 0, limit: Number.POSITIVE_INFINITY, repaired: new Set(), running: false };
    state.running = true;
    episodes.set(key, state);
    const run = async (): Promise<void> => {
      // The wire is only ever edited with the session process stopped.
      if (options.live(ref)) await options.stop(ref);
      state.attempts += 1;
      const result = await repairKimiUnloadPoison({ home: binding.home, cwd: binding.cwd, sessionId: id }, tool,
        { live: () => options.live(ref) });
      if (result.status === 'refused') {
        const reason = result.reason === 'live' ? hostText('kimiUnloadReasonLive')
          : result.reason === 'changed' ? hostText('kimiUnloadReasonChanged')
          : hostText('kimiUnloadReasonInvalid');
        return block(ref, tool, reason);
      }
      if (result.status === 'clean') return block(ref, tool, hostText('kimiUnloadReasonMissing'));
      // The first repair sees the whole poisoned set; later counts shrink as announcements are removed.
      if (state.limit === Number.POSITIVE_INFINITY) state.limit = result.poisoned;
      state.repaired.add(tool);
      options.notice(ref, 'kimi-unload-repaired', hostText('kimiUnloadRepaired', {
        session: ref.sessionId, tool, count: String(result.removed), backup: path.basename(result.backup),
      }).in(options.locale()));
      await options.resume(ref);
    };
    const attempt = options.serialize === undefined ? run() : options.serialize(ref, run);
    void attempt.catch((error: unknown) => {
      if (error instanceof HostError && error.data?.['reason'] === HOST_ERROR_REASONS.busy) return;
      options.log.warn('Kimi unload poison recovery failed', { ref, tool, error: String(error) });
      block(ref, tool, hostText('kimiUnloadReasonFailed', { detail: error instanceof Error ? error.message : String(error) }));
    }).finally(() => {
      state.running = false;
    });
  }

  return { turnEnd };
}
