/**
 * Задания роя (спека роя v1, 4): шаблон хоста + то, что написал создатель. Хост дописывает их к `objective` королевы и к
 * `task` трутня или проверяющего при создании сессии, поэтому правила не зависят от того, что вспомнит модель создателя.
 */

import type { SwarmMemberOutcome, SwarmRole } from '@parley/core';

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
- Add members with \`swarm_add\` (role "drone" with a slice task and a short \`slice\` name, later role "verifier" to recheck the key claims); the slice task must be self-contained. You cannot create other sessions or another swarm.
- Wait with \`wait_for\` on a member id or "inbox". Wait for the Parley letter that the wave has finished before you write the final summary: it lists the members that handed in partial coverage or did not hand in, and what is left of the swarm's sessions and time. An early \`report done\` closes the swarm and its still-working members. Read a member's result with \`get_map {session, field: "summary"}\`.
- Members close themselves when they hand in. For a gap worth the time, add one drone for that gap with a narrower task and the predecessor's hand-in, or cover it yourself; otherwise name the gap in the summary.
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
- Hand in with \`report\`: status done and \`coverage\` — "covered" if you read the whole slice and answered its questions, otherwise "partial". In the summary give facts with sources (\`path:line\` or url) and say what is left unread. If you could not do the task at all, report failed. After that you are closed.`;
}

/** Участник волны в письме конца волны: имя, id сессии, срез и исход (`memberOutcome`). */
export interface WaveEntry {
  /** `Drone 2`, `Verifier 1` (`memberName`). */
  name: string;
  sessionId: string;
  slice: string | null;
  outcome: SwarmMemberOutcome;
}

export interface WaveLetterInput {
  swarmId: string;
  /** Трутни и проверяющие волны: записи `members` после `announced`. */
  wave: WaveEntry[];
  /** Участники прежних волн с исходом не `covered`. */
  earlierNotClosed: number;
  /** Остаток роя; `null` — лимиты не прочитаны, строки нет. `minutes: null` — срока жизни нет. */
  left: { sessions: number; swarmSessions: number; minutes: number | null } | null;
}

/** Слова исходов в письме: `open` печатается как `did not hand in` и считается вместе с `missing` (спека «видимые дыры», 3.2). */
const OUTCOME_WORDS = [
  ['covered', 'covered'],
  ['partial', 'partial'],
  ['unstated', 'coverage not stated'],
  ['failed', 'reported failure'],
  ['missing', 'did not hand in'],
] as const;
const wordOf = (outcome: SwarmMemberOutcome): string => OUTCOME_WORDS.find(([key]) => key === (outcome === 'open' ? 'missing' : outcome))![1];

/** Письмо королеве о конце волны (3.5): счёт исходов, незакрытое, остаток роя и просьба проверить самооценки. */
export function waveLetter({ swarmId, wave, earlierNotClosed, left }: WaveLetterInput): string {
  const lines: string[] = [];
  if (wave.every((entry) => entry.outcome === 'covered')) {
    lines.push(`Wave finished in swarm ${swarmId}: all ${wave.length} members handed in and declared full coverage.`);
  } else {
    const counts = OUTCOME_WORDS
      .map(([key, word]) => ({ word, n: wave.filter((entry) => (entry.outcome === 'open' ? 'missing' : entry.outcome) === key).length }))
      .filter(({ n }) => n > 0)
      .map(({ word, n }) => `${n} ${word}`);
    lines.push(`Wave finished in swarm ${swarmId}: ${wave.length} members — ${counts.join(', ')}.`);
    lines.push('Not closed:');
    for (const entry of wave.filter((candidate) => candidate.outcome !== 'covered')) {
      lines.push(`- ${entry.name} (${entry.sessionId})${entry.slice === null ? '' : ` "${entry.slice}"`}: ${wordOf(entry.outcome)}`);
    }
  }
  if (earlierNotClosed > 0) {
    lines.push(`Earlier waves: ${earlierNotClosed} members not closed; your register says which of those gaps are closed since.`);
  }
  if (left !== null) {
    lines.push(`Left: ${left.sessions} of ${left.swarmSessions} swarm sessions, ${left.minutes === null ? 'no time limit' : `${left.minutes} min`}.`);
  }
  lines.push(
    "Coverage is the member's own estimate. Check the hand-ins against the objective, then either add members with swarm_add (a drone for a gap, verifiers for the claims) or call report with the combined result and name what stays uncovered.",
  );
  return lines.join('\n');
}
