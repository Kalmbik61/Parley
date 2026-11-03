// DEVELOPER BUILD ONLY: made-up `sessions.switchOptions` for the provider sheet screenshots (plan A38b).
import type { SwitchOptions } from '@parley/remote-client';

export const demoSwitchOptions: SwitchOptions = {
  current: { provider: 'claude', available: false, reason: 'limit' },
  targets: [
    { id: 'claude', label: 'Claude', family: null, available: false, needs: 'Usage limit — resets at 14:30', limits: null, transcript: false },
    { id: 'codex', label: 'Codex', family: null, available: true, needs: null, limits: { fiveHour: { usedPercent: 38 }, week: { usedPercent: 12 } } as never, transcript: true },
    { id: 'gemini', label: 'Gemini', family: null, available: false, needs: 'Sign in on your Mac', limits: null, transcript: false },
  ],
  suggested: 'codex',
  keeps: { rooms: 1, leads: ['Greta'], owns: [], children: 2, unread: 3, worktree: null },
  blockers: [],
};
