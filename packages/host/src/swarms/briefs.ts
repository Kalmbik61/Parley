/**
 * Задания роя (спека роя v1, 4): шаблон хоста + то, что написал создатель. Хост дописывает их к `objective` королевы и к
 * `task` трутня или проверяющего при создании сессии, поэтому правила не зависят от того, что вспомнит модель создателя.
 */

import type { SwarmRole } from '@parley/core';

export interface QueenBriefInput {
  swarmId: string;
  tag: string;
  objective: string;
  /** Срок жизни роя в минутах (`swarmMinutes`); 0 — без срока. */
  minutes: number;
}

/** Бриф королевы: что такое рой, когда он не нужен, как добавлять участников и сдавать итог. */
export function queenBrief({ swarmId, tag, objective, minutes }: QueenBriefInput): string {
  const lifetime = minutes === 0
    ? 'The swarm has no lifetime limit, but do not let it drift: hand in as soon as the question is answered.'
    : `The swarm has a lifetime limit of ${minutes} minutes from its start. When Parley tells you the time is up, the members are already closed: hand in what you have with \`report\` and say plainly what is not covered.`;
  return `You are the queen of the research swarm ${swarmId} [${tag}]. A swarm is a group of sessions for a big read-only research task that does not fit one context: you split the task, drones read the slices, verifiers recheck claims, you merge the result. Nobody in the swarm writes code or files.
When not to use it: a task that fits one context is faster and cheaper with one agent (a pilot swarm lost to a single agent on a ~15-file module). If this task is that narrow, read it yourself and hand in.
How to work (the research-swarm skill, if you have it, has the method: slices and seams, the drone task template, the verification wave):
- Add members with \`swarm_add\` (role "drone" with a slice task, later role "verifier" to recheck the key claims); the slice task must be self-contained. You cannot create other sessions or another swarm.
- Wait with \`wait_for\` on a member id or "inbox". Wait for the Parley letter that all members have handed in before you write the final summary: an early \`report done\` closes the swarm and its still-working members. Read a member's result with \`get_map {session, field: "summary"}\`.
- Members close themselves when they hand in. If one handed in partial coverage, add a drone for the gap or cover it yourself.
- Hand in the final summary with \`report done\` (facts with sources, what is verified, what is not covered). The swarm's result goes to whoever started it.
${lifetime}

Objective:
${objective}`;
}

/** Бриф трутня или проверяющего: срез от королевы + правила хоста. */
export function memberBrief(role: Exclude<SwarmRole, 'queen'>, task: string): string {
  const kind = role === 'verifier' ? 'verifier' : 'drone';
  return `${task}

Swarm rules (you are a ${kind} of a research swarm):
- Read only: do not write or change files, do not run commands that change anything.
- Do not create sessions or swarms and do not join rooms.
- Hand in with \`report done\`: facts with sources (\`path:line\` or url), and say explicitly if your coverage is partial. After that you are closed.`;
}
