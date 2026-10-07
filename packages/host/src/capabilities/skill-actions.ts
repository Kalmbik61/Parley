import { capabilitySkillResult, capabilitySkillTarget } from '@parley/protocol';
import type { CapabilitySkillResult, CapabilitySkillTarget } from '@parley/protocol';
import { shareSkill, unshareSkill } from './share-skill.js';
import type { SafeCapabilitiesService } from './snapshot.js';
import type { ProviderScheduler } from './scheduler.js';
/** Shares the same host queue as P17/P18; all private proof is refreshed at actual dispatch. */
export function createCapabilitiesSkillActions(service: SafeCapabilitiesService, scheduler: ProviderScheduler) {
  let disposed = false;
  const run = async (kind: 'share' | 'unshare', input: CapabilitySkillTarget): Promise<CapabilitySkillResult> => {
    const parsed = capabilitySkillTarget.safeParse(input);
    if (!parsed.success) return { outcome: 'denied', code: 'unverified' };
    if (disposed) return { outcome: 'denied', code: 'shutdown' };
    const params = parsed.data;
    try {
      return await scheduler.run(params.provider === 'claude' ? 'codex' : 'claude', async signal => {
        if (disposed || signal.aborted) return { outcome: 'denied', code: 'shutdown' };
        const prepared = await service.prepareSkillAction(params, kind);
        if (disposed || signal.aborted) return { outcome: 'denied', code: 'shutdown' };
        if (!prepared.ok) return { outcome: 'denied', code: prepared.code };
        const current = (): boolean => !disposed && !signal.aborted && prepared.isCurrent();
        const result = kind === 'share' ? await shareSkill(prepared.target, current, undefined, signal) : await unshareSkill(prepared.target, current);
        if (result.outcome === 'ok') service.refresh(params.projectPath);
        const safe = capabilitySkillResult.safeParse(result);
        return safe.success ? safe.data : { outcome: 'failed', code: 'io-error' };
      });
    } catch { return { outcome: 'failed', code: disposed ? 'shutdown' : 'io-error' }; }
  };
  return { share: (input: CapabilitySkillTarget) => run('share', input), unshare: (input: CapabilitySkillTarget) => run('unshare', input), dispose() { disposed = true; } };
}
