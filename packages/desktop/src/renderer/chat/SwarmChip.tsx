/**
 * Чип роя в шапке чата (спека роя v1, 7.2). У королевы — `[значок] Research · 3/5`, пока рой идёт, и `✓ 3/5` (⚠, ✕), когда
 * он закончился; у трутня и проверяющего — ссылка `in swarm Research`, она открывает королеву. Высота тулбара
 * фиксирована, чип не переносится.
 */

import type { WorkSwarm, WorkSwarmMember } from '@parley/core';
import { isSwarmTerminal, swarmProgress } from '@parley/core/swarms';
import { S } from '../../shared/strings.js';
import { applyFocusTarget, buildFocusTargetDeps } from '../attention/focus-target.js';
import { SwarmIcon } from '../components/SwarmIcon.js';
import { useSwarmIconMotion } from '../lib/use-swarm-icon-motion.js';

export interface SwarmChipProps {
  swarm: WorkSwarm;
  member: WorkSwarmMember;
  projectPath: string;
  workId: string;
}

const END_MARK = { done: '✓', failed: '⚠', cancelled: '✕' } as const;

export function SwarmChip({ swarm, member, projectPath, workId }: SwarmChipProps): JSX.Element {
  const reducedMotion = useSwarmIconMotion();
  const { handed, total } = swarmProgress(swarm);
  const counter = S.workSwarm.counter(handed, total);
  const title = S.workSwarm.rowTitle(swarm.tag, S.workSwarm.status[swarm.status]);
  if (member.role === 'queen') {
    const ended = isSwarmTerminal(swarm.status);
    return (
      <span data-testid="chat-swarm-chip" data-swarm-status={swarm.status} title={title} className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-foreground/6 px-2 py-0.5 text-xs font-medium tabular-nums">
        {ended ? <span aria-hidden="true">{END_MARK[swarm.status as keyof typeof END_MARK]}</span> : <SwarmIcon status={swarm.status} size={14} handed={handed} reducedMotion={reducedMotion} />}
        <span>{ended ? counter : `${swarm.tag} · ${counter}`}</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      data-testid="chat-swarm-chip"
      data-swarm-status={swarm.status}
      title={S.workSwarm.openQueen}
      onClick={() => {
        applyFocusTarget({ kind: 'session', ref: { projectPath, workId, sessionId: swarm.queen } }, buildFocusTargetDeps());
      }}
      className="inline-flex shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-full bg-foreground/6 px-2 py-0.5 text-xs font-medium hover:bg-foreground/10"
    >
      <SwarmIcon status={swarm.status} size={14} handed={handed} reducedMotion={reducedMotion} />
      <span>{S.workSwarm.inSwarm(swarm.tag)}</span>
    </button>
  );
}
