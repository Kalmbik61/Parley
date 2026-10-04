import type { RecipeDefinition } from './types.js';

/** Original short Lead playbooks; native minimal-development body stays on demand. */
export const BUILTIN_RECIPES: readonly RecipeDefinition[] = [
  {
    id: 'builtin:plan-build', source: 'builtin', name: 'Plan & build',
    description: 'Clarify, challenge, implement and independently verify a bounded change.', mode: 'verified',
    agents: [
      { role: 'builtin:planner', lead: true, worktree: false, count: 1 },
      { role: 'builtin:critic', lead: false, worktree: false, count: 1 },
      { role: 'builtin:executor', lead: false, worktree: true, count: 1 },
      { role: 'builtin:reviewer', lead: false, worktree: false, count: 1 },
    ],
    playbook: `Ask the human for the intended outcome and acceptance criteria in one message; wait for the answers.
Draft a bounded plan, ask the critic for concrete gaps, then revise it.
Submit the plan for human acceptance with each implementation item's owner, scope, criteria and independent reviewer.
If the navigator is available, use find_skill with for for the actual owner; assign a skill only when it fits, and assess the reviewer's skills separately.
Keep implementation changes small and complete, with appropriate behavioral evidence; preserve the human's requirements.
The reviewer can inspect an executor's worktree branch with git diff from the main checkout.
Resolve blockers and questions, then propose_completion only when the accepted verification requirements are satisfied.
Suggest remaining work for the backlog.`,
  },
  {
    id: 'builtin:review', source: 'builtin', name: 'Review',
    description: 'Review correctness and design without changing the submitted code.', mode: 'free',
    agents: [
      { role: 'builtin:reviewer', lead: true, worktree: false, count: 1 },
      { role: 'builtin:architect', lead: false, worktree: false, count: 1 },
    ],
    playbook: `Clarify the branch, pull request or commit range if the human's task leaves it ambiguous.
Assign correctness, regressions and meaningful tests to the reviewer, and boundaries and design to the architect.
If the navigator is available, use find_skill with for for each participant only where a suitable skill helps.
Keep the review read-only; give actionable findings with file, line, severity and evidence.
Combine findings into one decision with proposed actions and practical review limits.
After human acceptance, suggest unfinished follow-up work through backlog_suggest.`,
  },
  {
    id: 'builtin:debug', source: 'builtin', name: 'Debug',
    description: 'Reproduce a failure, isolate its cause and prove a minimal repair.', mode: 'checklist',
    agents: [
      { role: 'builtin:debugger', lead: true, worktree: true, count: 1 },
      { role: 'builtin:researcher', lead: false, worktree: false, count: 1 },
    ],
    playbook: `Reproduce the reported failure, preferably with a meaningful failing test.
Ask the researcher to check relevant logs, change history and documentation against concrete hypotheses.
If the navigator is available, find suitable participant skills with find_skill and for; otherwise continue with the same investigation.
Submit a checklist covering reproduction, root cause, the smallest complete repair and proof.
Keep the repair in the debugger's worktree and preserve the human's acceptance requirements.
Deliver the evidence and suggest remaining work for the backlog.`,
  },
];
