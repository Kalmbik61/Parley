// DEVELOPER BUILD ONLY: made-up `sessions.switchOptions` for the provider sheet screenshots (plan A38b). Real host
// shapes: the current provider is not among the targets, `needs` is a code, transcript only between Claude accounts.
import type { SwitchOptions } from '@parley/remote-client';

export const demoSwitchOptions: SwitchOptions = {
  current: { provider: 'claude', available: false, reason: 'limit' },
  targets: [
    { id: 'claude-work', label: 'Claude (work)', family: 'claude', available: true, needs: null, limits: { fiveHour: { usedPercent: 37.6 }, week: { usedPercent: 12.2 } } as never, transcript: true },
    { id: 'codex', label: 'Codex', family: null, available: true, needs: null, limits: null, transcript: false },
    { id: 'gemini', label: 'Gemini', family: null, available: false, needs: 'sign-in', limits: null, transcript: false },
    { id: 'glm', label: 'GLM', family: null, available: false, needs: 'key', limits: null, transcript: false },
  ],
  suggested: 'claude-work',
  keeps: { rooms: 1, leads: ['r1'], owns: [], children: 2, unread: 3, worktree: null },
  blockers: [],
};
